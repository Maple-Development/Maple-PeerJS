import { writable, get } from 'svelte/store';
import { toast } from 'svelte-sonner';
import { v4 as uuidv4 } from 'uuid';
import type { OwnDevice, TransferFile, TransferOffer, TransferReply } from '$shared/types/peer';
import type { MapleSocket } from './types';

const OFFER_TIMEOUT_MS = 10_000;

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
	 * pending: waiting for the user. answering: their answer is on its way to the server.
	 * accepted: the file should start arriving. failed: see `error`.
	 */
	status: 'pending' | 'answering' | 'accepted' | 'failed';
	/** Bytes received so far. Nothing fills this in until the file transfer exists. */
	received: number;
	error?: string;
}

/** Offers other devices have sent to this one, oldest first, until the user closes them. */
export const incomingTransfers = writable<IncomingTransfer[]>([]);

export interface OutgoingOffer {
	transferId: string;
	target: OwnDevice;
	file: TransferFile;
	/** 'accepted' once the other device said yes and is still online. */
	status: 'pending' | 'accepted';
}

/** Offers this device has sent that weren't declined or dropped. */
export const outgoingOffers = writable<OutgoingOffer[]>([]);

let socket: MapleSocket | null = null;

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
		// The server drops an offer when either side goes offline, without telling the other side.
		const online = new Set(list.map((device) => device.id));
		outgoingOffers.update((offers) => offers.filter((offer) => online.has(offer.target.id)));
		failIncoming(
			(offer) => !online.has(offer.sender.id),
			(offer) => `${offer.sender.name} went offline.`
		);
	});

	// IncomingOffer.svelte shows these as a popup.
	client.on('peer:incoming', (offer) => {
		incomingTransfers.update((list) => [...list, { offer, status: 'pending', received: 0 }]);
	});

	client.on('peer:decision', ({ transferId, accepted }) => {
		const offer = get(outgoingOffers).find((o) => o.transferId === transferId);
		if (!offer) return;
		const what = `"${offer.file.name}"`;

		if (!accepted) {
			removeOutgoing(transferId);
			toast.info(`${offer.target.name} declined ${what}`);
			return;
		}

		// The server checked this tab when the answer came in; make sure the other device
		// hasn't gone offline since, before treating the transfer as on.
		if (!client.connected || !get(devices).some((device) => device.id === offer.target.id)) {
			removeOutgoing(transferId);
			toast.error(`${offer.target.name} accepted ${what}, but is no longer online.`);
			return;
		}

		outgoingOffers.update((offers) =>
			offers.map((o) => (o.transferId === transferId ? { ...o, status: 'accepted' } : o))
		);
		toast.success(`${offer.target.name} accepted ${what}`);
	});

	client.on('disconnect', () => {
		devices.set([]);
		// The server drops pending offers when either side disconnects.
		outgoingOffers.set([]);
		failIncoming(
			() => true,
			() => 'Lost connection to the server.'
		);
	});
}

function removeOutgoing(transferId: string) {
	outgoingOffers.update((offers) => offers.filter((o) => o.transferId !== transferId));
}

function updateIncoming(id: string, change: (transfer: IncomingTransfer) => IncomingTransfer) {
	incomingTransfers.update((list) => list.map((t) => (t.offer.id === id ? change(t) : t)));
}

/** Mark incoming offers the server has dropped as failed, so their popup says why. */
function failIncoming(
	gone: (offer: TransferOffer) => boolean,
	reason: (offer: TransferOffer) => string
) {
	incomingTransfers.update((list) =>
		list.map((t) =>
			t.status !== 'failed' && gone(t.offer)
				? { ...t, status: 'failed', error: reason(t.offer) }
				: t
		)
	);
}

/** Accept or decline an incoming offer. Only the first answer counts. */
export async function answerOffer(id: string, accepted: boolean) {
	const transfer = get(incomingTransfers).find((t) => t.offer.id === id);
	if (transfer?.status !== 'pending') return;
	updateIncoming(id, (t) => ({ ...t, status: 'answering' }));

	const reply = await respondToOffer(id, accepted);
	// It may have failed meanwhile (e.g. the sender went offline); keep that reason.
	if (get(incomingTransfers).find((t) => t.offer.id === id)?.status !== 'answering') return;

	if (!reply.ok) updateIncoming(id, (t) => ({ ...t, status: 'failed', error: reply.error }));
	else if (accepted) updateIncoming(id, (t) => ({ ...t, status: 'accepted' }));
	else closeIncoming(id);
}

/** Take an answered or failed offer off the screen. */
export function closeIncoming(id: string) {
	incomingTransfers.update((list) => list.filter((t) => t.offer.id !== id));
}

/** Whether every byte of an accepted offer has arrived. */
export function isReceived(transfer: IncomingTransfer): boolean {
	return transfer.status === 'accepted' && transfer.received >= transfer.offer.file.size;
}

/**
 * Stop receiving an accepted offer, or throw away one that has arrived, and close it.
 * Only local for now: the server has no cancel event, so the sender isn't told.
 */
export function cancelIncoming(id: string) {
	closeIncoming(id);
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
 * Offer a file to another of this account's devices. On success the offer is tracked in
 * `outgoingOffers` until the other device answers.
 */
export async function sendOffer(target: OwnDevice, file: TransferFile): Promise<TransferReply> {
	const reply = await request((client, ack) =>
		client.timeout(OFFER_TIMEOUT_MS).emit('peer:offer', { targetDeviceId: target.id, file }, ack)
	);
	if (reply.ok) {
		outgoingOffers.update((offers) => [
			...offers,
			{ transferId: reply.transferId, target, file, status: 'pending' }
		]);
	}
	return reply;
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
