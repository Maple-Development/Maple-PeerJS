import { writable, get } from 'svelte/store';
import { toast } from 'svelte-sonner';
import { v4 as uuidv4 } from 'uuid';
import type {
	OwnDevice,
	TransferEnded,
	TransferFile,
	TransferOffer,
	TransferReply
} from '$shared/types/peer';
import type { Peer } from 'peerjs';
import type { MapleSocket } from './types';
import { PEER_SERVER } from './api/server';
import DeviceMessage from './components/DeviceMessage.svelte';

const OFFER_TIMEOUT_MS = 10_000;
// How long notices stay up once there's nothing left to cancel.
const NOTICE_MS = 5_000;

const CANCELLED_BY_SENDER = 'This transfer was canceled by the sender.';
const CANCELLED_BY_RECEIVER = 'This transfer was canceled by the receiver.';
const ENDED_UNEXPECTEDLY = 'Sorry, this transfer ended unexpectedly!';
const NO_PEER_SERVER = "Couldn't reach the transfer server.";
const NO_CONNECTION = "Couldn't connect to the other device.";

const DEVICE_ID_KEY = 'maple-transfer-device-id';
// A name the user picked for this browser. Without one, a name is made from the browser and OS.
const NAME_KEY = 'maple-device-custom-name';
const MAX_NAME = 40;

/** This account's online devices, as last published by the server. */
export const devices = writable<OwnDevice[]>([]);

/** This browser's device ID once known (empty until the first lookup finishes). */
export const selfId = writable('');

export interface IncomingTransfer {
	offer: TransferOffer;
	/**
	 * pending: waiting for the user. answering: their acceptance is on its way to the server.
	 * accepted: the file should start arriving. cancelled: the sender stopped it.
	 * failed: it ended some other way. `error` says why for the last two.
	 */
	status: 'pending' | 'answering' | 'accepted' | 'cancelled' | 'failed';
	/** Bytes received so far. Nothing fills this in until the file transfer exists. */
	received: number;
	/** This device asked the server to cancel and is waiting for it to confirm. */
	cancelling?: boolean;
	error?: string;
}

/** Offers other devices have sent to this one, oldest first, until the user closes them. */
export const incomingTransfers = writable<IncomingTransfer[]>([]);

export interface OutgoingOffer {
	transferId: string;
	target: OwnDevice;
	file: TransferFile;
	/**
	 * pending: waiting for the other device to answer (shown as a toast).
	 * accepted: sending (shown in the transfer popup).
	 * cancelled: the receiver stopped it. failed: it ended some other way.
	 */
	status: 'pending' | 'accepted' | 'cancelled' | 'failed';
	/** What notices call the file, e.g. the track's title. */
	label: string;
	/** Bytes sent so far. Nothing fills this in until the file transfer exists. */
	sent: number;
	/** This device asked the server to cancel and is waiting for it to confirm. */
	cancelling?: boolean;
	error?: string;
}

/**
 * Offers this device has sent that weren't declined or withdrawn. Accepted ones stay until
 * the user closes their popup, even after they end.
 */
export const outgoingOffers = writable<OutgoingOffer[]>([]);

let socket: MapleSocket | null = null;

/**
 * The Peer this tab opened for each accepted transfer, by transfer ID: the sender's once its
 * offer is accepted, the receiver's once it accepts. Resolves when the Peer is open.
 */
const peers = new Map<string, Promise<Peer>>();

/** Create this tab's Peer for a transfer and wait until the PeerServer has given it an ID. */
function openPeer(transferId: string): Promise<Peer> {
	const opening = (async () => {
		// peerjs needs browser APIs, so it only loads once a transfer starts.
		const { createPeer } = await import('./peerManager');
		const peer = createPeer(PEER_SERVER);
		await new Promise<void>((resolve, reject) => {
			peer.once('open', () => resolve());
			peer.once('error', (error) => {
				peer.destroy();
				reject(error);
			});
		});
		return peer;
	})();
	peers.set(transferId, opening);
	return opening;
}

/** Destroy this tab's Peer for a transfer, closing its connections. */
function closePeer(transferId: string) {
	const opening = peers.get(transferId);
	if (!opening) return;
	peers.delete(transferId);
	opening.then((peer) => peer.destroy()).catch(() => {});
}

/**
 * One ID per browser, shared by all its tabs, so they show up as a single device.
 * The lock stops two tabs opened at once from each creating a different ID.
 */
export async function getBrowserDeviceId(): Promise<string> {
	const readOrCreate = () => {
		let id = localStorage.getItem(DEVICE_ID_KEY);
		if (!id) {
			// uuidv4 rather than crypto.randomUUID: the latter only exists on https/localhost,
			// and the server requires a UUID.
			id = uuidv4();
			localStorage.setItem(DEVICE_ID_KEY, id);
		}
		return id;
	};
	// navigator.locks is also https/localhost-only; fall back to no lock elsewhere (e.g. a LAN IP).
	return navigator.locks ? navigator.locks.request(DEVICE_ID_KEY, readOrCreate) : readOrCreate();
}

/** e.g. "Chrome on Windows", used until the user renames this device. */
function defaultName(): string {
	const ua = navigator.userAgent;
	const browser = /Edg\//.test(ua)
		? 'Edge'
		: /OPR\//.test(ua)
			? 'Opera'
			: /Firefox\//.test(ua)
				? 'Firefox'
				: /Chrome\//.test(ua)
					? 'Chrome'
					: /Safari\//.test(ua)
						? 'Safari'
						: 'Browser';
	const os = /iPhone|iPad/.test(ua)
		? 'iOS'
		: /Android/.test(ua)
			? 'Android'
			: /Windows/.test(ua)
				? 'Windows'
				: /Mac OS X/.test(ua)
					? 'macOS'
					: /Linux/.test(ua)
						? 'Linux'
						: '';
	return os ? `${browser} on ${os}` : browser;
}

function currentName(): string {
	return localStorage.getItem(NAME_KEY)?.trim() || defaultName();
}

/** Register this browser as a device whenever the socket (re)connects, and track the device list. */
export function watchDevices(client: MapleSocket) {
	socket = client;
	const idPromise = getBrowserDeviceId().then((id) => {
		selfId.set(id);
		return id;
	});

	client.on('connect', async () => {
		client.emit('peer:register', { id: await idPromise, name: currentName() });
	});

	client.on('peer:devices', (list) => {
		devices.set(list);
		// The server sends peer:ended when a participant goes offline; this only catches
		// anything that slipped through.
		const online = new Set(list.map((device) => device.id));
		for (const offer of get(outgoingOffers)) {
			if (!online.has(offer.target.id)) endOutgoing(offer, 'disconnected');
		}
		for (const { offer } of get(incomingTransfers)) {
			if (!online.has(offer.sender.id)) endIncoming(offer.id, 'disconnected');
		}
	});

	// TransferDialog.svelte shows these as a popup.
	client.on('peer:incoming', (offer) => {
		incomingTransfers.update((list) => [...list, { offer, status: 'pending', received: 0 }]);
	});

	client.on('peer:decision', ({ transferId, accepted }) => {
		const offer = get(outgoingOffers).find((o) => o.transferId === transferId);
		if (offer?.status !== 'pending' || offer.cancelling) return;

		if (!accepted) {
			endOutgoing(offer, 'cancelled');
			return;
		}

		// The server checked this tab when the answer came in; make sure the other device
		// hasn't gone offline since, before treating the transfer as on.
		if (!client.connected || !get(devices).some((device) => device.id === offer.target.id)) {
			endOutgoing(offer, 'disconnected');
			return;
		}

		// The transfer popup takes over from the "waiting" notice.
		updateOutgoing(transferId, (o) => ({ ...o, status: 'accepted' }));
		toast.dismiss(transferId);
		// The sender creates its Peer now that the offer is accepted. It connects once
		// peer:connect brings the receiver's peer ID.
		openPeer(transferId).catch(() => failOutgoing(transferId, NO_PEER_SERVER));
	});

	// The receiver's Peer is ready: connect to it and start the transfer.
	client.on('peer:connect', async ({ transferId, peerId }) => {
		const opening = peers.get(transferId);
		if (!opening) return;
		try {
			const peer = await opening;
			const { connectToPeer } = await import('./peerManager');
			const conn = await connectToPeer(peer, peerId);
			if (peers.get(transferId) !== opening) {
				conn.close(); // ended while connecting
				return;
			}
			// Connected to the receiving device: the file transfer starts here, over conn.
		} catch {
			failOutgoing(transferId, NO_CONNECTION);
		}
	});

	// Sent to both sides whenever a transfer stops early, including to whoever stopped it.
	// That side has already dropped the transfer locally, so only the other side reacts.
	client.on('peer:ended', ({ transferId, reason }) => {
		endIncoming(transferId, reason);
		const offer = get(outgoingOffers).find((o) => o.transferId === transferId);
		if (offer) endOutgoing(offer, reason);
	});

	client.on('disconnect', () => {
		devices.set([]);
		// The server ends every transfer this tab was part of when it disconnects.
		for (const offer of get(outgoingOffers)) endOutgoing(offer, 'disconnected');
		for (const { offer } of get(incomingTransfers)) endIncoming(offer.id, 'disconnected');
	});
}

function removeOutgoing(transferId: string) {
	closePeer(transferId);
	outgoingOffers.update((offers) => offers.filter((o) => o.transferId !== transferId));
}

function updateOutgoing(transferId: string, change: (offer: OutgoingOffer) => OutgoingOffer) {
	outgoingOffers.update((offers) =>
		offers.map((o) => (o.transferId === transferId ? change(o) : o))
	);
}

/**
 * This device's Peer couldn't open or connect: show why in the transfer popup. Only the
 * receiver calls peer:finish, so the sender doesn't report this to the server.
 */
function failOutgoing(transferId: string, error: string) {
	closePeer(transferId);
	updateOutgoing(transferId, (o) => (isOver(o) ? o : { ...o, status: 'failed', error }));
}

/** Say why an offer this device sent was ended by the other side (or the network). */
function endOutgoing(offer: OutgoingOffer, reason: TransferEnded['reason']) {
	// The server has dropped the transfer, so the Peer has nothing left to do.
	closePeer(offer.transferId);
	if (isOver(offer)) return;
	// This device asked for it: the server ending it is the confirmation.
	if (offer.cancelling) {
		removeOutgoing(offer.transferId);
		toast.dismiss(offer.transferId);
		return;
	}

	// Once accepted it's in the popup, which keeps it on screen and says why.
	if (offer.status === 'accepted') {
		updateOutgoing(offer.transferId, (o) =>
			reason === 'cancelled'
				? { ...o, status: 'cancelled', error: CANCELLED_BY_RECEIVER }
				: { ...o, status: 'failed', error: ENDED_UNEXPECTEDLY }
		);
		return;
	}

	// Still waiting for an answer: replace the "waiting" notice.
	removeOutgoing(offer.transferId);
	const what = `"${offer.file.name}"`;
	// Same id as the "waiting" / "accepted" notice, so this replaces it. The replacement keeps
	// any option it doesn't set, so the old Cancel button has to be cleared explicitly.
	const options = { id: offer.transferId, duration: NOTICE_MS, action: undefined };

	if (reason === 'expired') {
		// Nothing is left on either device, so the user can simply offer it again.
		toast.info(DeviceMessage, {
			...options,
			componentProps: { device: offer.target.name, after: " didn't answer in time" },
			description: `The offer for "${offer.label}" expired.`,
			action: {
				label: 'Try again',
				onClick: () => void retryOffer(offer)
			}
		});
	} else if (reason !== 'cancelled') {
		toast.error(ENDED_UNEXPECTEDLY, { ...options, description: offer.file.name });
	} else {
		toast.info(DeviceMessage, {
			...options,
			componentProps: { device: offer.target.name, after: ` declined ${what}` }
		});
	}
}

async function retryOffer(offer: OutgoingOffer) {
	const reply = await sendOffer(offer.target, offer.file, offer.label);
	if (!reply.ok) toast.error(reply.error);
}

function updateIncoming(id: string, change: (transfer: IncomingTransfer) => IncomingTransfer) {
	incomingTransfers.update((list) => list.map((t) => (t.offer.id === id ? change(t) : t)));
}

/** Whether a transfer, either way, has stopped and only needs closing. */
export function isOver(transfer: { status: string }): boolean {
	return transfer.status === 'cancelled' || transfer.status === 'failed';
}

/** Keep an incoming offer the sender (or the network) ended on screen, saying why. */
function endIncoming(id: string, reason: TransferEnded['reason']) {
	// The server has dropped the transfer, so the Peer has nothing left to do.
	closePeer(id);
	const transfer = get(incomingTransfers).find((t) => t.offer.id === id);
	// This device asked for it: the server ending it is the confirmation.
	if (transfer?.cancelling) {
		closeIncoming(id);
		return;
	}
	// Nobody answered in time. The sender is told and can offer it again, so there's nothing
	// for this device to keep.
	if (reason === 'expired' && transfer && !isOver(transfer)) {
		closeIncoming(id);
		toast.info(DeviceMessage, {
			componentProps: {
				before: 'The offer from ',
				device: transfer.offer.sender.name,
				after: ' expired'
			},
			description: transfer.offer.file.name,
			duration: NOTICE_MS
		});
		return;
	}
	updateIncoming(id, (t) =>
		isOver(t)
			? t
			: reason === 'cancelled'
				? { ...t, status: 'cancelled', error: CANCELLED_BY_SENDER }
				: { ...t, status: 'failed', error: ENDED_UNEXPECTEDLY }
	);
}

/** Accept or decline an incoming offer. Only the first answer counts. */
export async function answerOffer(id: string, accepted: boolean) {
	const transfer = get(incomingTransfers).find((t) => t.offer.id === id);
	if (transfer?.status !== 'pending') return;

	if (!accepted) {
		closeIncoming(id);
		await respondToOffer(id, false);
		return;
	}

	updateIncoming(id, (t) => ({ ...t, status: 'answering' }));

	const reply = await respondToOffer(id, accepted);
	// It may have failed meanwhile (e.g. the sender went offline); keep that reason.
	if (get(incomingTransfers).find((t) => t.offer.id === id)?.status !== 'answering') return;

	if (!reply.ok) {
		updateIncoming(id, (t) => ({ ...t, status: 'failed', error: reply.error }));
		return;
	}
	updateIncoming(id, (t) => ({ ...t, status: 'accepted' }));
	await startReceiving(id);
}

/**
 * The receiver creates its Peer and, once it's open, sends its peer ID with peer:ready. The
 * server passes that to the sender (peer:connect), which connects to it.
 */
async function startReceiving(id: string) {
	const opening = openPeer(id);
	let peer: Peer;
	try {
		peer = await opening;
	} catch {
		failIncoming(id, NO_PEER_SERVER);
		return;
	}
	if (peers.get(id) !== opening) return; // ended while opening

	peer.on('connection', () => {
		// The sending device connected: the file transfer arrives over this connection. When it's
		// done, call finishTransfer(id, 'completed') (or 'failed').
	});

	const reply = await request((client, ack) =>
		client.timeout(OFFER_TIMEOUT_MS).emit('peer:ready', { transferId: id, peerId: peer.id }, ack)
	);
	if (!reply.ok) failIncoming(id, reply.error);
}

/** The receiver's side of the transfer broke: show why, and report it with peer:finish. */
function failIncoming(id: string, error: string) {
	closePeer(id);
	updateIncoming(id, (t) => (isOver(t) ? t : { ...t, status: 'failed', error }));
	void finishTransfer(id, 'failed');
}

/** Take an answered or failed offer off the screen. */
export function closeIncoming(id: string) {
	closePeer(id);
	incomingTransfers.update((list) => list.filter((t) => t.offer.id !== id));
}

/** Whether every byte of an accepted offer has arrived. */
export function isReceived(transfer: IncomingTransfer): boolean {
	return transfer.status === 'accepted' && transfer.received >= transfer.offer.file.size;
}

/**
 * Stop receiving an accepted offer, or throw away one that has arrived, and close it.
 * The sender is told it was canceled.
 */
export async function cancelIncoming(id: string) {
	const transfer = get(incomingTransfers).find((t) => t.offer.id === id);
	if (!transfer || transfer.cancelling || isOver(transfer)) return;
	updateIncoming(id, (t) => ({ ...t, cancelling: true }));

	// The server's peer:ended (handled in endIncoming) usually closes it before this returns.
	const reply = await cancelTransfer(id);
	const now = get(incomingTransfers).find((t) => t.offer.id === id);
	if (!now?.cancelling) return;
	if (reply.ok) {
		closeIncoming(id);
	} else {
		updateIncoming(id, (t) => ({ ...t, cancelling: false }));
		toast.error(`Couldn't cancel: ${reply.error}`);
	}
}

/**
 * Keep a track once it has fully arrived.
 * Placeholder: with no file transfer yet there's nothing to save, so this only closes it.
 */
export function confirmIncoming(id: string) {
	const transfer = get(incomingTransfers).find((t) => t.offer.id === id);
	if (!transfer || !isReceived(transfer)) return;
	closeIncoming(id);
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type Ack = (err: Error | null, reply: TransferReply) => void;

/** Emit an event the server answers, giving up after OFFER_TIMEOUT_MS. */
function request(send: (client: MapleSocket, ack: Ack) => void): Promise<TransferReply> {
	const client = socket;
	if (!client?.connected) {
		return Promise.resolve({ ok: false, error: 'Not connected.' });
	}
	return new Promise((resolve) =>
		send(client, (err, reply) =>
			resolve(err ? { ok: false, error: 'The server did not respond.' } : reply)
		)
	);
}

/**
 * Offer a file to another of this account's devices, called `label` in notices. On success
 * the offer is tracked in `outgoingOffers` and a "waiting" notice stays up until the other
 * device answers. On failure the caller decides how to show the error.
 */
export async function sendOffer(
	target: OwnDevice,
	file: TransferFile,
	label = file.name
): Promise<TransferReply> {
	const reply = await request((client, ack) =>
		client.timeout(OFFER_TIMEOUT_MS).emit('peer:offer', { targetDeviceId: target.id, file }, ack)
	);
	if (!reply.ok) return reply;

	const { transferId } = reply;
	outgoingOffers.update((offers) => [
		...offers,
		{ transferId, target, file, label, status: 'pending', sent: 0 }
	]);
	// Stays up until the other device answers. peer:decision then swaps it for the transfer
	// popup, or endOutgoing replaces it (same id) if the offer is declined, expires or drops.
	toast.info(DeviceMessage, {
		id: transferId,
		componentProps: { before: 'Waiting for ', device: target.name, after: ` to accept "${label}"` },
		duration: Number.POSITIVE_INFINITY,
		action: { label: 'Cancel', onClick: () => void cancelOutgoing(transferId) }
	});
	return reply;
}

/**
 * Withdraw an offer this device sent, before or after it was accepted.
 * The other device is told it was canceled.
 */
export async function cancelOutgoing(transferId: string) {
	const offer = get(outgoingOffers).find((o) => o.transferId === transferId);
	if (!offer || offer.cancelling || isOver(offer)) return;
	updateOutgoing(transferId, (o) => ({ ...o, cancelling: true }));

	// The server's peer:ended (handled in endOutgoing) usually removes it before this returns.
	const reply = await cancelTransfer(transferId);
	const now = get(outgoingOffers).find((o) => o.transferId === transferId);
	if (!now?.cancelling) return;
	if (reply.ok) {
		removeOutgoing(transferId);
		toast.dismiss(transferId);
	} else {
		updateOutgoing(transferId, (o) => ({ ...o, cancelling: false }));
		toast.error(`Couldn't cancel: ${reply.error}`);
	}
}

/** Whether every byte of an accepted offer has gone out. */
export function isSent(offer: OutgoingOffer): boolean {
	return offer.status === 'accepted' && offer.sent >= offer.file.size;
}

/**
 * Take a sent or ended offer off the screen.
 * Placeholder: once the file transfer exists, finishing should also tell the server.
 */
export function closeOutgoing(transferId: string) {
	const offer = get(outgoingOffers).find((o) => o.transferId === transferId);
	if (offer && (isOver(offer) || isSent(offer))) removeOutgoing(transferId);
}

/** Tell the server to end a transfer. If it already ended there's nothing left to do. */
function cancelTransfer(transferId: string): Promise<TransferReply> {
	return request((client, ack) =>
		client.timeout(OFFER_TIMEOUT_MS).emit('peer:cancel', { transferId }, ack)
	);
}

/**
 * The receiver tells the server the transfer is done (peer:finish), and how it went. The server
 * then ends it for both devices with peer:ended.
 */
export function finishTransfer(
	transferId: string,
	outcome: 'completed' | 'failed'
): Promise<TransferReply> {
	return request((client, ack) =>
		client.timeout(OFFER_TIMEOUT_MS).emit('peer:finish', { transferId, outcome }, ack)
	);
}

/** Answer an offer another device sent to this one. */
export function respondToOffer(transferId: string, accepted: boolean): Promise<TransferReply> {
	return request((client, ack) =>
		client.timeout(OFFER_TIMEOUT_MS).emit('peer:respond', { transferId, accepted }, ack)
	);
}

/**
 * Rename this browser. The server only lets a socket rename its own device,
 * so other devices have to be renamed from themselves.
 */
export function renameSelf(name: string) {
	const trimmed = name.trim();
	const id = get(selfId);
	if (!trimmed || trimmed.length > MAX_NAME || !id) return;
	localStorage.setItem(NAME_KEY, trimmed);
	socket?.emit('peer:register', { id, name: trimmed });
}
