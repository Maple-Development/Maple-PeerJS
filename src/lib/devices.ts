import { writable, get } from 'svelte/store';
import { toast } from 'svelte-sonner';
import { v4 as uuidv4 } from 'uuid';
import type {
	OwnDevice,
	TransferBatch,
	TransferBatchTrack,
	TransferEnded,
	TransferFile,
	TransferOffer,
	TransferReply
} from '$shared/types/peer';
import type { DataConnection, Peer } from 'peerjs';
import {
	MAX_ARTWORK_BYTES,
	MAX_PLAYLIST_DESCRIPTION,
	type Album,
	type MapleSocket,
	type Playlist,
	type Song,
	type TransferredAlbumMetadata,
	type TransferredArtwork,
	type TransferredPlaylistMetadata,
	type TransferredTrackMetadata
} from './types';
import type { DuplicateChoice } from './library';
import { PEER_SERVER } from './api/server';
import DeviceMessage from './components/DeviceMessage.svelte';
import { browser } from '$app/env';
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { IFS } from './ifs';
import { OPFS } from './opfs';
import { INTERNAL_LOCATION } from './preferences/usersettings';

const OFFER_TIMEOUT_MS = 10_000;
// In a batch, the sender offers the next file as soon as the last one ends. If none comes in this
// long, the receiver stops waiting.
const NEXT_FILE_TIMEOUT_MS = 30_000;
/** The most tracks one batch can send (the server's limit). */
export const MAX_BATCH_TRACKS = 500;
// How long notices stay up once there's nothing left to cancel.
const NOTICE_MS = 5_000;

const CANCELLED_BY_SENDER = 'This transfer was canceled by the sender.';
const CANCELLED_BY_RECEIVER = 'This transfer was canceled by the receiver.';
const ENDED_UNEXPECTEDLY = 'Sorry, this transfer ended unexpectedly!';
const NO_PEER_SERVER = "Couldn't reach the transfer server.";
const NO_CONNECTION = "Couldn't connect to the other device.";
const NO_RESPONSE = 'The other device stopped responding.';
const CORRUPTED = 'The file arrived damaged.';
const CANCELLED_BY_YOU = 'You canceled this transfer.';
const STOPPED_SENDING = 'The other device stopped sending.';

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
	/** Bytes received so far (from receiveChunks). */
	received: number;
	/** The whole file arrived, its checksum matched, and the server confirmed (peer:ended). */
	completed?: boolean;
	/** This device asked the server to cancel and is waiting for it to confirm. */
	cancelling?: boolean;
	/**
	 * Once the file has arrived: the track already in this library that it duplicates (same ID,
	 * or same title and artist), whether Maple stores it or it is in a linked folder (`linked`).
	 * The user then picks what to do with it.
	 */
	duplicate?: { title: string; artist: string; linked: boolean };
	/** Set when the file is part of an IncomingBatch, which the popup shows instead. */
	batchId?: string;
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
	/** The file itself, sent once the other device's Peer is connected. */
	data: Blob;
	/** The track's library entry (minus its artwork), sent in the start message. */
	track: TransferredTrackMetadata;
	/** Set when the track is sent as part of an album: sent in the start message too. */
	album?: AlbumToSend;
	/** Set when the track is sent as part of a playlist: sent in the start message too. */
	playlist?: PlaylistToSend;
	/** Bytes the receiver has acknowledged so far (from sendChunks). */
	sent: number;
	/** The receiver checked the file and reported it complete (peer:ended with 'completed'). */
	completed?: boolean;
	/** This device asked the server to cancel and is waiting for it to confirm. */
	cancelling?: boolean;
	/** Set when the file is part of the OutgoingBatch, which the popup shows instead. */
	batchId?: string;
	error?: string;
}

/**
 * Offers this device has sent that weren't declined or withdrawn. Accepted ones stay until
 * the user closes their popup, even after they end.
 */
export const outgoingOffers = writable<OutgoingOffer[]>([]);

/**
 * The tracks the user chose to send ("Send to Device" on a track, an album or a playlist, or
 * several picked on the Transfers tab), while they pick which device gets them. `album` is set
 * when they're an album's tracks, in album order; `playlist` when they're a playlist's, in its
 * order. TransferDialog.svelte shows the picker; it's cleared once they're sent (then `onSent`
 * runs) or the picker is closed.
 */
export const tracksToSend = writable<{
	songs: Song[];
	album?: Album;
	playlist?: Playlist;
	onSent?: () => void;
} | null>(null);

/**
 * An album sent with its tracks: its metadata and cover go in each track's start message, so
 * the receiver files every track under the same album, with the same cover.
 */
export interface AlbumToSend {
	metadata: TransferredAlbumMetadata;
	artwork?: TransferredArtwork;
}

/**
 * What's sent of an album along with its tracks. Its cover is left out if it can't be read or
 * is too big to send; the receiver then uses the one in each track's file.
 */
export async function albumToSend(album: Album): Promise<AlbumToSend> {
	const metadata: TransferredAlbumMetadata = {
		name: album.name,
		artist: album.artist,
		year: album.year,
		...(album.genre ? { genre: album.genre } : {})
	};
	const artwork = await artworkToSend(album.image);
	return artwork ? { metadata, artwork } : { metadata };
}

/**
 * A playlist sent with its tracks: the receiver adds the tracks, then makes a playlist of them
 * in the same order, with this name, description and cover.
 */
export interface PlaylistToSend {
	metadata: TransferredPlaylistMetadata;
	artwork?: TransferredArtwork;
}

/**
 * What's sent of a playlist along with its tracks. Its cover is left out if it can't be read
 * or is too big to send; the receiver's playlist then gets the placeholder.
 */
export async function playlistToSend(playlist: Playlist): Promise<PlaylistToSend> {
	const metadata: TransferredPlaylistMetadata = {
		name: playlistName(playlist),
		description: (playlist.description ?? '').slice(0, MAX_PLAYLIST_DESCRIPTION),
		...(playlist.createdAt ? { createdAt: playlist.createdAt } : {}),
		...(playlist.modifiedAt ? { modifiedAt: playlist.modifiedAt } : {})
	};
	const artwork = await artworkToSend(playlist.image);
	return artwork ? { metadata, artwork } : { metadata };
}

/** A playlist's name as it's sent: never empty, and within the server's limit. */
function playlistName(playlist: Pick<Playlist, 'name'>): string {
	return (playlist.name?.trim() || 'Untitled playlist').slice(0, 255);
}

/** A cover to send, or nothing if it can't be read or is too big. */
async function artworkToSend(image: string | Blob | undefined): Promise<TransferredArtwork | undefined> {
	try {
		const cover =
			image instanceof Blob
				? image
				: image
					? await (await OPFS.get().image(image)).blob()
					: undefined;
		if (cover && cover.size > 0 && cover.size <= MAX_ARTWORK_BYTES) {
			return { bytes: await cover.arrayBuffer(), type: await imageType(cover) };
		}
	} catch {
		// Sent without it.
	}
	return undefined;
}

/** An album or playlist sent along with its tracks (at most one of the two). */
export interface TracksCollection {
	album?: AlbumToSend;
	playlist?: PlaylistToSend;
}

/** A cover's MIME type. Covers saved in OPFS don't keep theirs, so it's read from the bytes. */
async function imageType(image: Blob): Promise<string> {
	if (image.type.startsWith('image/')) return image.type;
	const b = new Uint8Array(await image.slice(0, 12).arrayBuffer());
	if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
	if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
	if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57) {
		return 'image/webp';
	}
	return '';
}

/** How a batch handles a track the library already has: skip it, or as for one track. */
export type BatchDuplicateChoice = DuplicateChoice | 'skip';

/** One file of the batch this device is sending. */
export interface OutgoingBatchItem {
	song: Song;
	/** What notices call it, e.g. the track's title. */
	label: string;
	file: TransferFile;
	data: Blob;
}

/**
 * Several tracks this device is sending to one other device. Each file is its own transfer,
 * offered once the one before it ends (the server allows one at a time per sender). The other
 * device accepts the first and then the rest by itself.
 */
export interface OutgoingBatch {
	id: string;
	target: OwnDevice;
	items: OutgoingBatchItem[];
	/** The item on offer or being sent (an index into items). */
	index: number;
	/**
	 * offered: waiting for the other device to accept (shown as a toast). sending: accepted;
	 * the files go one after another (shown in the transfer popup). done: every file had its
	 * turn. cancelled / failed: it stopped early; `error` says why.
	 */
	status: 'offered' | 'sending' | 'done' | 'cancelled' | 'failed';
	/** The current item's transfer, once the server has taken its offer. */
	transferId?: string;
	/** Bytes of the items whose turn is over, sent or not. */
	doneBytes: number;
	/** Items the other device checked and kept. */
	sent: number;
	/** Items whose transfer failed (the batch went on without them). */
	failed: number;
	/** How each item whose turn is over went, by its index. */
	results: ('sent' | 'failed')[];
	/** Tracks the user picked that this device couldn't read, so they were left out. */
	unreadable: number;
	/** Set when the batch is an album's tracks. */
	album?: AlbumToSend;
	/** Set when the batch is a playlist's tracks. */
	playlist?: PlaylistToSend;
	/** This device asked to stop the batch and is waiting for the server to confirm. */
	cancelling?: boolean;
	error?: string;
}

/** The batch this device is sending, until the user closes its popup. One at a time. */
export const outgoingBatch = writable<OutgoingBatch | null>(null);

/** Several tracks another device is sending to this one (see OutgoingBatch). */
export interface IncomingBatch {
	id: string;
	sender: OwnDevice;
	/** Files still to come when the batch was offered to this device, and their bytes. */
	count: number;
	size: number;
	/** Set when the batch is an album's tracks: the album's name. */
	album?: string;
	/**
	 * Set when the batch is a playlist's tracks: the playlist's name. Once the batch ends, the
	 * tracks that made it are put in a new playlist, whose ID is then `playlistId`.
	 */
	playlist?: string;
	playlistId?: string;
	/**
	 * Those files' tracks, in order, as the sender listed them. Missing if this tab first heard of
	 * the batch partway through (only the first offer carries the list).
	 */
	tracks?: TransferBatchTrack[];
	/** The batch index of this device's first file, which `tracks` and `results` count from. */
	start: number;
	/** Where the file on offer or arriving now is in `tracks`. */
	position: number;
	/**
	 * pending: waiting for the user. answering: their acceptance is on its way. receiving: the
	 * files are arriving, and each is added to the library as it does. done: every file had its
	 * turn. cancelled / failed: it stopped early; `error` says why.
	 */
	status: 'pending' | 'answering' | 'receiving' | 'done' | 'cancelled' | 'failed';
	/** The transfer of the file on offer or arriving now. */
	transferId?: string;
	/** Where the files are saved: INTERNAL_LOCATION or a linked folder's ID, and its name. */
	location: string;
	folderName?: string;
	onDuplicate: BatchDuplicateChoice;
	/** Files whose transfer has ended (any way), and their bytes. */
	settled: number;
	doneBytes: number;
	/** How the settled files went. Adding one to the library finishes a little after it arrives. */
	imported: number;
	skipped: number;
	failed: number;
	/** How each file went once it's settled and added, by its place in `tracks`. */
	results: ('imported' | 'skipped' | 'failed')[];
	/** This device asked to stop the batch and is waiting for the server to confirm. */
	cancelling?: boolean;
	error?: string;
}

/** Batches other devices are sending to this one, oldest first, until the user closes them. */
export const incomingBatches = writable<IncomingBatch[]>([]);

let socket: MapleSocket | null = null;

/**
 * The Peer this tab opened for each accepted transfer, by transfer ID: the sender's once its
 * offer is accepted, the receiver's once it accepts. Resolves when the Peer is open.
 */
const peers = new Map<string, Promise<Peer>>();

/**
 * How a transfer ended. sent: the receiver checked the whole file. imported / discarded: the
 * receiver kept it or threw it away. declined / expired: the offer was turned down or nobody
 * answered. cancelled: either side stopped it. failed: it ended some other way.
 */
export type TransferOutcome =
	| 'sent'
	| 'imported'
	| 'discarded'
	| 'declined'
	| 'expired'
	| 'cancelled'
	| 'failed';

/** A transfer that has ended, as the Transfers tab lists it. */
export interface FinishedTransfer {
	id: string;
	/** in: another device sent it to this one. out: this device sent it. */
	direction: 'in' | 'out';
	/** The track's title, or the file name if this device never got the track's metadata. */
	title: string;
	artist?: string;
	size: number;
	/** The other device's name. */
	peer: string;
	outcome: TransferOutcome;
	/** Why it ended, when there's more to say than the outcome. */
	detail?: string;
	/** The batch it was part of, if any. */
	batch?: string;
	endedAt: number;
}

/**
 * Transfers that ended while this tab was open, newest first. Kept in memory only, so a
 * reload clears it. Each transfer is added once, when it ends, even if its popup is still open.
 */
export const transferHistory = writable<FinishedTransfer[]>([]);

/**
 * IDs already added, so a transfer that ends two ways at once (a cancel racing the server's
 * peer:ended) shows once. Not emptied by clearTransferHistory.
 */
const recorded = new Set<string>();

function record(entry: Omit<FinishedTransfer, 'endedAt'>) {
	if (recorded.has(entry.id)) return;
	recorded.add(entry.id);
	transferHistory.update((list) => [{ ...entry, endedAt: Date.now() }, ...list]);
}

function recordOutgoing(offer: OutgoingOffer, outcome: TransferOutcome, detail?: string) {
	record({
		id: offer.transferId,
		direction: 'out',
		title: offer.label,
		artist: offer.track.artist || undefined,
		size: offer.file.size,
		peer: offer.target.name,
		outcome,
		detail,
		batch: offer.batchId
	});
}

/** `track` is the metadata the sender sent, once it has arrived. */
function recordIncoming(
	transfer: IncomingTransfer,
	outcome: TransferOutcome,
	detail?: string,
	track?: TransferredTrackMetadata
) {
	record({
		id: transfer.offer.id,
		direction: 'in',
		title: track?.title || transfer.offer.file.name,
		artist: track?.artist || undefined,
		size: transfer.offer.file.size,
		peer: transfer.offer.sender.name,
		outcome,
		detail,
		batch: transfer.batchId
	});
}

/** Empty the Transfers tab's history. Transfers that haven't ended aren't affected. */
export function clearTransferHistory() {
	transferHistory.set([]);
}

/** Files that fully arrived and checked out, kept until the user confirms or closes them. */
const receivedFiles = new Map<
	string,
	{
		audio: Blob;
		track: TransferredTrackMetadata;
		album?: TransferredAlbumMetadata;
		artwork?: TransferredArtwork;
		playlist?: TransferredPlaylistMetadata;
		playlistArtwork?: TransferredArtwork;
	}
>();

/** Create this tab's Peer for a transfer and wait until the PeerServer has given it an ID. */
function openPeer(transferId: string): Promise<Peer> {
	const opening = (async () => {
		if (!browser) throw new Error('Peers can only be opened in the browser.');
		// peerjs needs browser APIs, and its CommonJS build breaks server rendering, so it only
		// loads once a transfer starts. Don't import peerManager statically from this module.
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
		// A batch can be between files, with no transfer for the server to end.
		for (const batch of get(incomingBatches)) {
			if (!online.has(batch.sender.id)) endIncomingBatch(batch.id, 'failed', ENDED_UNEXPECTEDLY);
		}
		const sending = get(outgoingBatch);
		if (sending && !online.has(sending.target.id)) endOutgoingBatch('failed', ENDED_UNEXPECTEDLY);
	});

	// TransferDialog.svelte shows these as a popup.
	client.on('peer:incoming', (offer) => {
		if (offer.batch) {
			receiveBatchOffer(offer, offer.batch);
			return;
		}
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
		if (offer.batchId) {
			const batch = get(outgoingBatch);
			if (batch?.id === offer.batchId && batch.status === 'offered') {
				outgoingBatch.set({ ...batch, status: 'sending' });
				toast.dismiss(batch.id);
			}
		}
		// The sender creates its Peer now that the offer is accepted. It connects once
		// peer:connect brings the receiver's peer ID.
		openPeer(transferId).catch(() => failOutgoing(transferId, NO_PEER_SERVER));
	});

	// The receiver's Peer is ready: connect to it and start the transfer.
	client.on('peer:connect', async ({ transferId, peerId }) => {
		const opening = peers.get(transferId);
		const offer = get(outgoingOffers).find((o) => o.transferId === transferId);
		if (!opening || !offer) return;
		const { data, track, album, playlist } = offer;

		const { connectToPeer, sendStart, sendChunks, sendEnd } = await import('./peerManager');
		let conn: DataConnection;
		try {
			conn = await connectToPeer(await opening, peerId);
		} catch {
			failOutgoing(transferId, NO_CONNECTION);
			return;
		}
		if (peers.get(transferId) !== opening) {
			conn.close(); // ended while connecting
			return;
		}

		try {
			// Tell the receiver what's coming (with the track's metadata) and wait for its ack
			// (nextOffset 0).
			await sendStart(conn, transferId, data.size, track, { album, playlist });
			// Send the file; resolves with its SHA-256 once the receiver has acked every byte. The
			// acks drive the popup's progress bar.
			const checksum = await sendChunks(conn, data, (bytes) =>
				updateOutgoing(transferId, (o) => ({ ...o, sent: bytes }))
			);
			// The receiver checks the file against this, then reports it with peer:finish. The
			// server's peer:ended (reason 'completed') marks it done here.
			await sendEnd(conn, checksum);
		} catch {
			if (peers.get(transferId) === opening) failOutgoing(transferId, NO_RESPONSE);
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
		for (const batch of get(incomingBatches)) {
			endIncomingBatch(batch.id, 'failed', ENDED_UNEXPECTEDLY);
		}
		endOutgoingBatch('failed', ENDED_UNEXPECTEDLY);
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
 * Sending broke on this device: show why in the transfer popup. Only the receiver calls
 * peer:finish, so the sender doesn't report this to the server; closing the Peer drops the
 * connection, which the receiver notices.
 */
function failOutgoing(transferId: string, error: string) {
	closePeer(transferId);
	const offer = get(outgoingOffers).find((o) => o.transferId === transferId);
	if (!offer || isOver(offer) || offer.completed) return;
	updateOutgoing(transferId, (o) => ({ ...o, status: 'failed', error }));
	recordOutgoing(offer, 'failed', error);
	// A batch waits for the server to end this file before offering the next, so tell it now
	// rather than wait for the receiver to notice.
	if (offer.batchId) void finishTransfer(transferId, 'failed');
}

/**
 * An offer this device sent ended (on the server, or because the other device went offline).
 * A batch then moves on to its next file.
 */
function endOutgoing(offer: OutgoingOffer, reason: TransferEnded['reason']) {
	const state = get(outgoingOffers).find((o) => o.transferId === offer.transferId) ?? offer;
	endOutgoingOffer(state, reason);
	if (state.batchId) outgoingItemEnded(state, reason);
}

/** Say why an offer this device sent was ended by the other side (or the network). */
function endOutgoingOffer(offer: OutgoingOffer, reason: TransferEnded['reason']) {
	// The server has dropped the transfer, so the Peer has nothing left to do.
	closePeer(offer.transferId);
	// Once it's done, the other device going offline afterwards doesn't undo it.
	if (isOver(offer) || offer.completed) return;
	// The receiver checked the file and reported it with peer:finish. The popup's Done button
	// takes it from here.
	if (reason === 'completed') {
		updateOutgoing(offer.transferId, (o) => ({ ...o, completed: true, sent: o.file.size }));
		recordOutgoing(offer, 'sent');
		return;
	}
	// This device asked for it: the server ending it is the confirmation.
	if (offer.cancelling) {
		recordOutgoing(offer, 'cancelled', CANCELLED_BY_YOU);
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
		if (reason === 'cancelled') recordOutgoing(offer, 'cancelled', CANCELLED_BY_RECEIVER);
		else recordOutgoing(offer, 'failed', ENDED_UNEXPECTEDLY);
		return;
	}

	// Still waiting for an answer: replace the "waiting" notice.
	removeOutgoing(offer.transferId);
	if (reason === 'expired') recordOutgoing(offer, 'expired');
	else if (reason === 'cancelled') recordOutgoing(offer, 'declined');
	else recordOutgoing(offer, 'failed', ENDED_UNEXPECTEDLY);
	// A batch has its own notices (see outgoingItemEnded).
	if (offer.batchId) return;
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
	const reply = await sendOffer(offer.target, offer.file, offer.data, offer.track, offer.label);
	if (!reply.ok) toast.error(reply.error);
}

function updateIncoming(id: string, change: (transfer: IncomingTransfer) => IncomingTransfer) {
	incomingTransfers.update((list) => list.map((t) => (t.offer.id === id ? change(t) : t)));
}

/** Whether a transfer, either way, has stopped and only needs closing. */
export function isOver(transfer: { status: string }): boolean {
	return transfer.status === 'cancelled' || transfer.status === 'failed';
}

/**
 * An offer to this device ended (on the server, or because the sender went offline). In a
 * batch, a file that arrived is then added to the library.
 */
function endIncoming(id: string, reason: TransferEnded['reason']) {
	const batchId = get(incomingTransfers).find((t) => t.offer.id === id)?.batchId;
	endIncomingTransfer(id, reason);
	if (batchId) incomingItemEnded(batchId, id, reason);
}

/** Keep an incoming offer the sender (or the network) ended on screen, saying why. */
function endIncomingTransfer(id: string, reason: TransferEnded['reason']) {
	// The server has dropped the transfer, so the Peer has nothing left to do.
	closePeer(id);
	const transfer = get(incomingTransfers).find((t) => t.offer.id === id);
	// It already arrived; the sender going offline afterwards doesn't take it back.
	if (transfer?.completed) return;
	// This tab reported it complete with peer:finish; this is the server confirming it.
	if (reason === 'completed') {
		if (transfer && !isOver(transfer)) {
			updateIncoming(id, (t) => ({ ...t, completed: true, received: t.offer.file.size }));
		}
		return;
	}
	// This device asked for it: the server ending it is the confirmation.
	if (transfer?.cancelling) {
		recordIncoming(transfer, 'cancelled', CANCELLED_BY_YOU);
		closeIncoming(id);
		return;
	}
	// Nobody answered in time. The sender is told and can offer it again, so there's nothing
	// for this device to keep.
	if (reason === 'expired' && transfer && !isOver(transfer)) {
		recordIncoming(transfer, 'expired');
		closeIncoming(id);
		if (transfer.batchId) return; // the batch says so instead
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
	if (!transfer || isOver(transfer)) return;
	if (reason === 'cancelled') {
		updateIncoming(id, (t) => ({ ...t, status: 'cancelled', error: CANCELLED_BY_SENDER }));
		recordIncoming(transfer, 'cancelled', CANCELLED_BY_SENDER);
	} else {
		updateIncoming(id, (t) => ({ ...t, status: 'failed', error: ENDED_UNEXPECTEDLY }));
		recordIncoming(transfer, 'failed', ENDED_UNEXPECTEDLY);
	}
}

/** Accept or decline an incoming offer. Only the first answer counts. */
export async function answerOffer(id: string, accepted: boolean) {
	const transfer = get(incomingTransfers).find((t) => t.offer.id === id);
	if (transfer?.status !== 'pending') return;

	if (!accepted) {
		recordIncoming(transfer, 'declined');
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
		recordIncoming(transfer, 'failed', reply.error);
		if (transfer.batchId) {
			// Make sure the sender isn't left waiting for this file, then stop the batch.
			closeIncoming(id);
			void cancelTransfer(id);
			endIncomingBatch(transfer.batchId, 'failed', reply.error);
		}
		return;
	}
	updateIncoming(id, (t) => ({ ...t, status: 'accepted' }));
	await startReceiving(transfer.offer);
}

/**
 * The receiver creates its Peer and, once it's open, sends its peer ID with peer:ready. The
 * server passes that to the sender (peer:connect), which connects to it.
 */
async function startReceiving(offer: TransferOffer) {
	const id = offer.id;
	const opening = openPeer(id);
	let peer: Peer;
	try {
		peer = await opening;
	} catch {
		failIncoming(id, NO_PEER_SERVER);
		return;
	}
	if (peers.get(id) !== opening) return; // ended while opening

	// Loaded before listening, so nothing is awaited between the sender connecting and
	// receiveStart listening for its start message.
	const { receiveStart, receiveChunks } = await import('./peerManager');
	let connected = false;

	peer.on('connection', async (conn) => {
		// Only the sender of this offer gets this peer ID, and only one connection is used.
		if (connected) {
			conn.close();
			return;
		}
		connected = true;

		const chunks: ArrayBuffer[] = [];
		let track: TransferredTrackMetadata;
		let album: TransferredAlbumMetadata | undefined;
		let artwork: TransferredArtwork | undefined;
		let playlist: TransferredPlaylistMetadata | undefined;
		let playlistArtwork: TransferredArtwork | undefined;
		try {
			// Check the sender's start message against the offer, and validate the track metadata
			// it carries.
			const start = await receiveStart(
				conn,
				{ transferId: id, size: offer.file.size },
				async () => {
					// Nothing to set up: the chunks are kept in memory until the end message.
				}
			);
			track = start.track;
			album = start.album;
			artwork = start.artwork;
			playlist = start.playlist;
			playlistArtwork = start.playlistArtwork;
			// The sender's device says a batch is a playlist in each start message too, so the
			// popup names it even if the server didn't pass the playlist's name on with the offer.
			const playlistName = start.playlist?.name;
			const batchId = offer.batch?.id;
			if (playlistName && batchId) {
				updateIncomingBatch(batchId, (b) =>
					b.playlist || b.album ? b : { ...b, playlist: playlistName }
				);
			}
			// Ack the start (nextOffset 0), take the chunks in order, and wait for the end message.
			// Resolves once the file's SHA-256 matches the sender's (otherwise 'Checksum mismatch').
			let received = 0;
			await receiveChunks(conn, start, async (bytes) => {
				chunks.push(bytes);
				received += bytes.byteLength;
				updateIncoming(id, (t) => ({ ...t, received }));
			});
		} catch (error) {
			if (peers.get(id) !== opening) return;
			const mismatch = error instanceof Error && error.message === 'Checksum mismatch';
			failIncoming(id, mismatch ? CORRUPTED : ENDED_UNEXPECTEDLY);
			return;
		}
		if (peers.get(id) !== opening) return; // ended meanwhile

		// Look for a copy already in the library now, so the popup can ask what to do with it.
		// Importing checks again, in case the library changed meanwhile.
		try {
			const { findDuplicateTrack } = await import('./library');
			const existing = await findDuplicateTrack(track);
			if (existing) {
				const duplicate = {
					title: existing.title,
					artist: existing.artist,
					linked: existing.source?.kind === 'linked-folder'
				};
				updateIncoming(id, (t) => ({ ...t, duplicate }));
			}
		} catch {
			// Not knowing just means the popup doesn't ask; importing still won't overwrite it.
		}
		if (peers.get(id) !== opening) return;

		// The transfer is done: report it. The server answers both devices with peer:ended
		// ('completed'), which marks it complete in endIncoming / endOutgoing.
		receivedFiles.set(id, {
			audio: new Blob(chunks, { type: offer.file.type }),
			track,
			album,
			artwork,
			playlist,
			playlistArtwork
		});
		const reply = await finishTransfer(id, 'completed');
		if (!reply.ok && !get(incomingTransfers).find((t) => t.offer.id === id)?.completed) {
			failIncoming(id, reply.error);
		}
	});

	const reply = await request((client, ack) =>
		client.timeout(OFFER_TIMEOUT_MS).emit('peer:ready', { transferId: id, peerId: peer.id }, ack)
	);
	if (!reply.ok) failIncoming(id, reply.error);
}

/** The receiver's side of the transfer broke: show why, and report it with peer:finish. */
function failIncoming(id: string, error: string) {
	closePeer(id);
	receivedFiles.delete(id);
	const transfer = get(incomingTransfers).find((t) => t.offer.id === id);
	if (transfer && !isOver(transfer) && !transfer.completed) {
		updateIncoming(id, (t) => ({ ...t, status: 'failed', error }));
		recordIncoming(transfer, 'failed', error);
	}
	void finishTransfer(id, 'failed');
}

/** Take an answered or failed offer off the screen. */
export function closeIncoming(id: string) {
	closePeer(id);
	receivedFiles.delete(id);
	incomingTransfers.update((list) => list.filter((t) => t.offer.id !== id));
}

/** Whether an accepted offer has fully arrived, checked out, and been confirmed by the server. */
export function isReceived(transfer: IncomingTransfer): boolean {
	return transfer.status === 'accepted' && !!transfer.completed;
}

/**
 * Stop receiving an accepted offer, or throw away one that has arrived, and close it.
 * The sender is told it was canceled.
 */
export async function cancelIncoming(id: string) {
	const transfer = get(incomingTransfers).find((t) => t.offer.id === id);
	if (!transfer || transfer.cancelling || isOver(transfer)) return;
	// The server is done with it once it has arrived; only this device still has the file.
	if (transfer.completed) {
		recordIncoming(transfer, 'discarded');
		closeIncoming(id);
		return;
	}
	updateIncoming(id, (t) => ({ ...t, cancelling: true }));

	// The server's peer:ended (handled in endIncoming) usually closes it before this returns.
	const reply = await cancelTransfer(id);
	const now = get(incomingTransfers).find((t) => t.offer.id === id);
	if (!now?.cancelling) return;
	if (reply.ok) {
		recordIncoming(transfer, 'cancelled', CANCELLED_BY_YOU);
		closeIncoming(id);
	} else {
		updateIncoming(id, (t) => ({ ...t, cancelling: false }));
		toast.error(`Couldn't cancel: ${reply.error}`);
	}
}

/**
 * Keep a track once it has fully arrived: close the popup and add it to the library under the
 * sender's track ID and metadata. The cover is read from the audio file itself. If the library
 * already has the track (`duplicate` on the transfer), `onDuplicate` says whether to keep both
 * or replace the old one. `location` is INTERNAL_LOCATION or the ID of a linked (external)
 * folder to save the file into.
 */
export async function confirmIncoming(
	id: string,
	{
		location = INTERNAL_LOCATION,
		onDuplicate
	}: { location?: string; onDuplicate?: DuplicateChoice } = {}
) {
	const transfer = get(incomingTransfers).find((t) => t.offer.id === id);
	if (!transfer || !isReceived(transfer)) return;

	let folderName: string | undefined;
	if (location !== INTERNAL_LOCATION) {
		// Asked first, while the click still counts as a user gesture. If it's refused, the popup
		// stays open so the track can be saved somewhere else instead.
		try {
			folderName = (await IFS.requestWriteAccess(location)).name;
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Couldn't open that folder.");
			return;
		}
		if (!get(incomingTransfers).some((t) => t.offer.id === id)) return; // closed meanwhile
	}

	await saveReceived(transfer, location, folderName, transfer.duplicate ? onDuplicate : undefined);
}

/** What happened to a file that arrived, and the ID its track has in the library if it's there. */
type SavedOutcome = { outcome: 'imported' | 'skipped' | 'failed'; trackId?: string };

/**
 * Add a file that arrived to the library, record how it went, and close it. Says so in a
 * notice unless `quiet` (a batch sums it up instead). Resolves with what happened to it. A
 * single track sent as a playlist (a playlist of one) is put in a new playlist too.
 */
async function saveReceived(
	transfer: IncomingTransfer,
	location: string,
	folderName: string | undefined,
	onDuplicate: DuplicateChoice | undefined,
	quiet = false
): Promise<SavedOutcome> {
	const id = transfer.offer.id;
	const received = receivedFiles.get(id);
	closeIncoming(id);
	if (!received) {
		recordIncoming(transfer, 'failed', 'The file is no longer available.');
		return { outcome: 'failed' };
	}
	const saved = await addReceivedTrack(transfer, received, location, folderName, onDuplicate, quiet);
	if (!transfer.batchId && received.playlist && saved.trackId) {
		void addReceivedPlaylist(received.playlist, [saved.trackId], received.playlistArtwork);
	}
	return saved;
}

async function addReceivedTrack(
	transfer: IncomingTransfer,
	received: NonNullable<ReturnType<typeof receivedFiles.get>>,
	location: string,
	folderName: string | undefined,
	onDuplicate: DuplicateChoice | undefined,
	quiet: boolean
): Promise<SavedOutcome> {

	const notify = (show: () => void) => {
		if (!quiet) show();
	};
	const { audio, track, album, artwork } = received;
	try {
		// Loaded on demand: the library code pulls in the metadata parser.
		const { importTransferredTrack } = await import('./library');
		const { result, id: trackId } = await importTransferredTrack(
			new File([audio], track.fileName, { type: audio.type }),
			track,
			onDuplicate,
			location,
			artwork ? new Blob([artwork.bytes], { type: artwork.type }) : undefined,
			album
		);
		const where = folderName ? `Saved in “${folderName}”.` : undefined;
		const detail = (text?: string) => [text, where].filter(Boolean).join(' ') || undefined;
		if (result === 'imported') {
			recordIncoming(transfer, 'imported', detail(), track);
			notify(() =>
				toast.success(`Added "${track.title}" to your library.`, { description: where })
			);
		} else if (result === 'replaced') {
			recordIncoming(transfer, 'imported', detail('Replaced the copy in your library.'), track);
			notify(() =>
				toast.success(`Replaced "${track.title}" in your library.`, { description: where })
			);
		} else if (result === 'kept-both') {
			recordIncoming(transfer, 'imported', detail('Added as a second copy.'), track);
			notify(() =>
				toast.success(`Added another copy of "${track.title}" to your library.`, {
					description: where
				})
			);
		} else {
			// A batch set to skip duplicates leaves a track that's already here alone.
			recordIncoming(transfer, quiet ? 'discarded' : 'imported', 'Already in your library.', track);
			notify(() => toast.info(`"${track.title}" is already in your library.`));
			return { outcome: 'skipped', trackId };
		}
		return { outcome: 'imported', trackId };
	} catch (error) {
		const reason = error instanceof Error ? error.message : 'Something went wrong.';
		recordIncoming(transfer, 'failed', `Couldn't add it to your library: ${reason}`, track);
		notify(() => toast.error(`Couldn't add "${track.title}": ${reason}`));
		return { outcome: 'failed' };
	}
}

/**
 * Make the playlist another device sent, from its tracks' IDs in this library, and say so in a
 * notice unless `quiet` (a batch's popup says so instead; failing is always noticed). Resolves
 * with its ID, or undefined if it couldn't be made.
 */
async function addReceivedPlaylist(
	metadata: TransferredPlaylistMetadata,
	trackIds: string[],
	artwork?: TransferredArtwork,
	quiet = false
): Promise<string | undefined> {
	try {
		const { importTransferredPlaylist } = await import('./library');
		const id = await importTransferredPlaylist(
			metadata,
			trackIds,
			artwork ? new Blob([artwork.bytes], { type: artwork.type }) : undefined
		);
		if (!quiet) {
			toast.success(`Added the playlist “${metadata.name}” to your library.`, {
				action: { label: 'Open', onClick: () => void openPlaylist(id) }
			});
		}
		return id;
	} catch (error) {
		const reason = error instanceof Error ? error.message : 'Something went wrong.';
		toast.error(`Couldn't make the playlist “${metadata.name}”: ${reason}`, {
			description: 'Its tracks are still in your library.'
		});
		return undefined;
	}
}

/** Go to a playlist's page. */
export function openPlaylist(id: string) {
	return goto(resolve('/playlists/playlist/[slug]', { slug: id }));
}

// Batches: several tracks sent to one device together. Each file is still its own transfer
// (offer, Peer, checksum); the batch offers them one after another and the receiver answers
// for all of them at once.

/** Whether a batch, either way, has stopped and only needs closing. */
export function isBatchOver(batch: { status: string }): boolean {
	return batch.status === 'done' || batch.status === 'cancelled' || batch.status === 'failed';
}

/** What notices call a batch: the album “Name”, the playlist “Name”, or e.g. 12 tracks. */
function describeBatch(batch: OutgoingBatch): string {
	if (batch.album) return `the album “${batch.album.metadata.name}”`;
	if (batch.playlist) return `the playlist “${batch.playlist.metadata.name}”`;
	return `${batch.items.length} tracks`;
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function updateOutgoingBatch(id: string, change: (batch: OutgoingBatch) => OutgoingBatch) {
	outgoingBatch.update((batch) => (batch?.id === id ? change(batch) : batch));
}

/** Stop the batch this device is sending, if it's still going, saying why in its popup. */
function endOutgoingBatch(status: 'done' | 'cancelled' | 'failed', error?: string) {
	const batch = get(outgoingBatch);
	if (!batch || isBatchOver(batch)) return;
	toast.dismiss(batch.id);
	// Never accepted, so there's no popup: a notice says what happened instead.
	if (batch.status === 'offered') {
		outgoingBatch.set(null);
		if (status === 'failed') {
			toast.error(error ?? ENDED_UNEXPECTEDLY, { description: capitalize(describeBatch(batch)) });
		}
		return;
	}
	outgoingBatch.set({ ...batch, status, error, transferId: undefined, cancelling: false });
}

/**
 * Send several tracks to another device. The other device is asked once; once it accepts, the
 * files go one at a time and the transfer popup shows how far along they are. `unreadable` is
 * how many of the tracks the user picked couldn't be read, so they aren't in `items`. When the
 * tracks are an album's or a playlist's, `collection` says which.
 */
export async function sendBatch(
	target: OwnDevice,
	items: OutgoingBatchItem[],
	unreadable = 0,
	{ album, playlist }: TracksCollection = {}
): Promise<TransferReply> {
	if (items.length < 2 || items.length > MAX_BATCH_TRACKS) {
		return { ok: false, error: `Pick between 2 and ${MAX_BATCH_TRACKS} tracks.` };
	}
	const current = get(outgoingBatch);
	if (current && !isBatchOver(current)) {
		return { ok: false, error: "Wait until the tracks you're sending now are done." };
	}
	const batch: OutgoingBatch = {
		id: uuidv4(),
		target,
		items,
		index: 0,
		status: 'offered',
		doneBytes: 0,
		sent: 0,
		failed: 0,
		results: [],
		unreadable,
		album,
		playlist
	};
	outgoingBatch.set(batch);
	// Up before the offer goes out, so an answer that comes back quickly can take it down.
	toast.info(DeviceMessage, {
		id: batch.id,
		componentProps: {
			before: 'Waiting for ',
			device: target.name,
			after: ` to accept ${describeBatch(batch)}`
		},
		duration: Number.POSITIVE_INFINITY,
		action: { label: 'Cancel', onClick: () => void cancelOutgoingBatch() }
	});
	const reply = await offerBatchItem(batch.id);
	if (!reply.ok && get(outgoingBatch)?.id === batch.id) {
		outgoingBatch.set(null);
		toast.dismiss(batch.id);
	}
	return reply;
}

/** Offer the batch's current item. */
async function offerBatchItem(batchId: string): Promise<TransferReply> {
	const batch = get(outgoingBatch);
	if (batch?.id !== batchId || isBatchOver(batch)) {
		return { ok: false, error: 'These tracks are no longer being sent.' };
	}
	const item = batch.items[batch.index];
	const size = batch.items.slice(batch.index).reduce((sum, i) => sum + i.file.size, 0);
	const reply = await sendOffer(
		batch.target,
		item.file,
		item.data,
		item.song,
		item.label,
		{
			id: batch.id,
			index: batch.index,
			count: batch.items.length,
			size,
			...(batch.album ? { album: batch.album.metadata.name } : {}),
			...(batch.playlist ? { playlist: batch.playlist.metadata.name } : {}),
			// The first offer lists every track, so the other device can show what it's accepting.
			...(batch.index === 0
				? {
						tracks: batch.items.map(({ song }) => ({
							title: (song.title || song.fileName || '').slice(0, 200),
							artist: (song.artist || '').slice(0, 200)
						}))
					}
				: {})
		},
		{
			album: batch.album,
			// The playlist's cover goes with each file until one has arrived: one copy is enough.
			playlist:
				batch.playlist && batch.sent > 0
					? { metadata: batch.playlist.metadata }
					: batch.playlist
		}
	);
	if (!reply.ok) return reply;
	const now = get(outgoingBatch);
	if (now?.id !== batchId || isBatchOver(now)) {
		// Stopped while the offer was on its way: withdraw it.
		void cancelOutgoing(reply.transferId);
		return reply;
	}
	updateOutgoingBatch(batchId, (b) => ({ ...b, transferId: reply.transferId }));
	return reply;
}

/** An item of the batch this device is sending ended: move on to the next, or stop. */
function outgoingItemEnded(offer: OutgoingOffer, reason: TransferEnded['reason']) {
	// The batch's popup shows its items, so they don't stay in the list once they end.
	removeOutgoing(offer.transferId);
	const batch = get(outgoingBatch);
	if (!batch || batch.id !== offer.batchId || batch.transferId !== offer.transferId) return;
	if (isBatchOver(batch)) return;

	// The first file was never accepted: the offer for the whole batch was turned down,
	// expired or dropped. Same notices as for one track.
	if (batch.status === 'offered') {
		outgoingBatch.set(null);
		if (batch.cancelling) {
			toast.dismiss(batch.id);
			return;
		}
		const what = describeBatch(batch);
		const options = { id: batch.id, duration: NOTICE_MS, action: undefined };
		if (reason === 'expired') {
			toast.info(DeviceMessage, {
				...options,
				componentProps: { device: batch.target.name, after: " didn't answer in time" },
				description: `The offer for ${what} expired.`,
				action: { label: 'Try again', onClick: () => void retryBatch(batch) }
			});
		} else if (reason === 'cancelled') {
			toast.info(DeviceMessage, {
				...options,
				componentProps: { device: batch.target.name, after: ` declined ${what}` }
			});
		} else {
			toast.error(ENDED_UNEXPECTEDLY, { ...options, description: capitalize(what) });
		}
		return;
	}

	if (reason === 'completed' || (reason === 'failed' && !batch.cancelling)) {
		// A file that failed is left out; the rest still go.
		nextBatchItem(batch, reason === 'completed' ? 'sent' : 'failed');
	} else if (reason === 'cancelled' || batch.cancelling) {
		endOutgoingBatch('cancelled', batch.cancelling ? CANCELLED_BY_YOU : CANCELLED_BY_RECEIVER);
	} else {
		endOutgoingBatch('failed', ENDED_UNEXPECTEDLY);
	}
}

function nextBatchItem(batch: OutgoingBatch, outcome: 'sent' | 'failed') {
	const finished: OutgoingBatch = {
		...batch,
		transferId: undefined,
		doneBytes: batch.doneBytes + batch.items[batch.index].file.size,
		sent: batch.sent + (outcome === 'sent' ? 1 : 0),
		failed: batch.failed + (outcome === 'failed' ? 1 : 0),
		results: Object.assign([...batch.results], { [batch.index]: outcome })
	};
	if (batch.cancelling) {
		outgoingBatch.set(finished);
		endOutgoingBatch('cancelled', CANCELLED_BY_YOU);
		return;
	}
	if (batch.index + 1 >= batch.items.length) {
		outgoingBatch.set({ ...finished, status: 'done' });
		return;
	}
	outgoingBatch.set({ ...finished, index: batch.index + 1 });
	void offerBatchItem(batch.id).then((reply) => {
		if (!reply.ok) endOutgoingBatch('failed', reply.error);
	});
}

async function retryBatch(batch: OutgoingBatch) {
	const reply = await sendBatch(batch.target, batch.items, batch.unreadable, {
		album: batch.album,
		playlist: batch.playlist
	});
	if (!reply.ok) toast.error(reply.error);
}

/**
 * Stop the batch this device is sending: withdraw the file on offer or being sent, and send
 * no more. Files already sent stay on the other device.
 */
export async function cancelOutgoingBatch() {
	const batch = get(outgoingBatch);
	if (!batch || isBatchOver(batch) || batch.cancelling) return;
	const id = batch.transferId;
	// Between two files, or the first offer is on its way (offerBatchItem withdraws it).
	if (!id) {
		if (batch.status === 'offered') {
			outgoingBatch.set(null);
			toast.dismiss(batch.id);
		} else {
			endOutgoingBatch('cancelled', CANCELLED_BY_YOU);
		}
		return;
	}
	updateOutgoingBatch(batch.id, (b) => ({ ...b, cancelling: true }));
	await cancelOutgoing(id);

	// The server's peer:ended usually ends the batch first (in outgoingItemEnded). If
	// cancelOutgoing finished without it, end it here.
	const now = get(outgoingBatch);
	if (now?.id !== batch.id || !now.cancelling || now.transferId !== id) return;
	const offer = get(outgoingOffers).find((o) => o.transferId === id);
	if (offer && !offer.cancelling) {
		updateOutgoingBatch(batch.id, (b) => ({ ...b, cancelling: false })); // couldn't cancel
	} else if (!offer) {
		if (now.status === 'offered') {
			outgoingBatch.set(null);
			toast.dismiss(now.id);
		} else {
			endOutgoingBatch('cancelled', CANCELLED_BY_YOU);
		}
	}
}

/** Take the batch this device sent off the screen once it has ended. */
export function closeOutgoingBatch() {
	const batch = get(outgoingBatch);
	if (batch && isBatchOver(batch)) outgoingBatch.set(null);
}

function updateIncomingBatch(id: string, change: (batch: IncomingBatch) => IncomingBatch) {
	incomingBatches.update((list) => list.map((b) => (b.id === id ? change(b) : b)));
}

function findIncomingBatch(id: string) {
	return get(incomingBatches).find((b) => b.id === id);
}

/** Waiting for the next file of a batch, by batch ID (see NEXT_FILE_TIMEOUT_MS). */
const nextFileTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearNextFileTimer(batchId: string) {
	clearTimeout(nextFileTimers.get(batchId));
	nextFileTimers.delete(batchId);
}

function waitForNextFile(batchId: string) {
	clearNextFileTimer(batchId);
	const batch = findIncomingBatch(batchId);
	if (batch?.status !== 'receiving' || batch.settled >= batch.count) return;
	nextFileTimers.set(
		batchId,
		setTimeout(() => {
			nextFileTimers.delete(batchId);
			const now = findIncomingBatch(batchId);
			if (now?.status === 'receiving' && !now.transferId) {
				endIncomingBatch(batchId, 'failed', STOPPED_SENDING);
			}
		}, NEXT_FILE_TIMEOUT_MS)
	);
}

/** Stop a batch another device is sending to this one, if it's still going, saying why. */
function endIncomingBatch(id: string, status: 'done' | 'cancelled' | 'failed', error?: string) {
	const batch = findIncomingBatch(id);
	if (!batch || isBatchOver(batch)) return;
	clearNextFileTimer(id);
	updateIncomingBatch(id, (b) => ({
		...b,
		status,
		error,
		transferId: undefined,
		cancelling: false
	}));
	void finishIncomingPlaylist(id);
}

/**
 * For each batch to this device: the tracks being added right now, and the ID in this library
 * of each track that made it, by its place in the batch. When the batch is a playlist's tracks,
 * also the playlist's metadata and cover (from the start messages, or else just the name the
 * offer gave). Kept until the batch has ended and, for a playlist, the playlist is made.
 */
const incomingPlaylists = new Map<
	string,
	{
		metadata?: TransferredPlaylistMetadata;
		artwork?: TransferredArtwork;
		saving: number;
		trackIds: (string | undefined)[];
	}
>();

/**
 * Once a playlist's batch has ended (however it ended) and nothing is still being added, make
 * the playlist from the tracks that made it, in order.
 */
async function finishIncomingPlaylist(batchId: string) {
	const entry = incomingPlaylists.get(batchId);
	if (!entry || entry.saving > 0) return;
	const batch = findIncomingBatch(batchId);
	if (batch && !isBatchOver(batch)) return;
	incomingPlaylists.delete(batchId);
	const trackIds = entry.trackIds.filter((id): id is string => !!id);
	if (!entry.metadata || !trackIds.length) return;
	// The batch's popup says so while it's up; once it's been closed a notice does.
	const playlistId = await addReceivedPlaylist(
		entry.metadata,
		trackIds,
		entry.artwork,
		!!findIncomingBatch(batchId)
	);
	if (playlistId) updateIncomingBatch(batchId, (b) => ({ ...b, playlistId }));
}

/**
 * An offer that's part of a batch arrived. The batch's first file asks the user (for all of
 * them); once they've accepted, the rest are accepted here as they come.
 */
function receiveBatchOffer(offer: TransferOffer, info: TransferBatch) {
	const transfer: IncomingTransfer = { offer, status: 'pending', received: 0, batchId: info.id };
	const batch = findIncomingBatch(info.id);
	if (!batch) {
		incomingBatches.update((list) => [
			...list,
			{
				id: info.id,
				sender: offer.sender,
				count: info.count - info.index,
				size: info.size,
				album: info.album,
				playlist: info.playlist,
				tracks: info.tracks?.slice(info.index),
				start: info.index,
				position: 0,
				status: 'pending',
				transferId: offer.id,
				location: INTERNAL_LOCATION,
				onDuplicate: 'skip',
				settled: 0,
				doneBytes: 0,
				imported: 0,
				skipped: 0,
				failed: 0,
				results: []
			}
		]);
		incomingTransfers.update((list) => [...list, transfer]);
		return;
	}
	if (
		batch.sender.id !== offer.sender.id ||
		batch.status !== 'receiving' ||
		batch.transferId ||
		batch.cancelling
	) {
		// The batch was stopped here (or a file is already arriving): turning this file down
		// stops the sender too.
		void respondToOffer(offer.id, false);
		return;
	}
	clearNextFileTimer(batch.id);
	updateIncomingBatch(batch.id, (b) => ({
		...b,
		transferId: offer.id,
		position: info.index - b.start
	}));
	incomingTransfers.update((list) => [...list, transfer]);
	void answerOffer(offer.id, true);
}

/**
 * Accept every file of a batch. Each is added to the library as it arrives: saved to
 * `location` (INTERNAL_LOCATION or a linked folder's ID), and a track the library already has
 * is skipped, kept as a second copy or replaced, as `onDuplicate` says.
 */
export async function acceptBatch(
	id: string,
	{
		location = INTERNAL_LOCATION,
		onDuplicate = 'skip'
	}: { location?: string; onDuplicate?: BatchDuplicateChoice } = {}
) {
	const batch = findIncomingBatch(id);
	if (batch?.status !== 'pending' || !batch.transferId) return;
	updateIncomingBatch(id, (b) => ({ ...b, status: 'answering' }));

	let folderName: string | undefined;
	if (location !== INTERNAL_LOCATION) {
		// Asked first, while the click still counts as a user gesture. If it's refused, the
		// popup asks again so another place can be picked.
		try {
			folderName = (await IFS.requestWriteAccess(location)).name;
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Couldn't open that folder.");
			updateIncomingBatch(id, (b) => (b.status === 'answering' ? { ...b, status: 'pending' } : b));
			return;
		}
	}
	const now = findIncomingBatch(id);
	if (now?.status !== 'answering' || !now.transferId) return; // ended meanwhile
	updateIncomingBatch(id, (b) => ({
		...b,
		status: 'receiving',
		location,
		folderName,
		onDuplicate
	}));
	await answerOffer(now.transferId, true);
}

/** Turn down a whole batch. */
export async function declineBatch(id: string) {
	const batch = findIncomingBatch(id);
	if (batch?.status !== 'pending' || !batch.transferId) return;
	incomingBatches.update((list) => list.filter((b) => b.id !== id));
	await answerOffer(batch.transferId, false);
}

/** A file of a batch to this device ended: add it to the library if it arrived, then wait for the next. */
function incomingItemEnded(batchId: string, id: string, reason: TransferEnded['reason']) {
	const batch = findIncomingBatch(batchId);
	const transfer = get(incomingTransfers).find((t) => t.offer.id === id);
	if (!batch || batch.transferId !== id || isBatchOver(batch)) {
		closeIncoming(id);
		return;
	}

	// Never accepted: the offer for the whole batch was withdrawn, expired or dropped.
	if (batch.status === 'pending' || batch.status === 'answering') {
		closeIncoming(id);
		if (reason === 'expired') {
			incomingBatches.update((list) => list.filter((b) => b.id !== batchId));
			toast.info(DeviceMessage, {
				componentProps: { before: 'The offer from ', device: batch.sender.name, after: ' expired' },
				description: `${batch.count} tracks`,
				duration: NOTICE_MS
			});
		} else if (reason === 'cancelled') {
			endIncomingBatch(batchId, 'cancelled', CANCELLED_BY_SENDER);
		} else {
			endIncomingBatch(batchId, 'failed', ENDED_UNEXPECTEDLY);
		}
		return;
	}

	updateIncomingBatch(batchId, (b) => ({
		...b,
		transferId: undefined,
		settled: b.settled + 1,
		doneBytes: b.doneBytes + (transfer?.offer.file.size ?? 0)
	}));

	const position = batch.position;
	if (transfer && isReceived(transfer)) {
		void addBatchItem(batchId, transfer, position);
	} else {
		closeIncoming(id);
		if (reason === 'cancelled') {
			endIncomingBatch(
				batchId,
				'cancelled',
				batch.cancelling ? CANCELLED_BY_YOU : CANCELLED_BY_SENDER
			);
			return;
		}
		if (reason !== 'completed' && reason !== 'failed') {
			endIncomingBatch(batchId, 'failed', ENDED_UNEXPECTEDLY);
			return;
		}
		// This file didn't make it; the sender goes on with the next.
		countBatchResult(batchId, 'failed', position);
	}
	waitForNextFile(batchId);
}

async function addBatchItem(batchId: string, transfer: IncomingTransfer, position: number) {
	const batch = findIncomingBatch(batchId);
	if (!batch) {
		closeIncoming(transfer.offer.id);
		return;
	}
	const onDuplicate = batch.onDuplicate === 'skip' ? undefined : batch.onDuplicate;

	// Note where each track ends up, so if the batch is a playlist's tracks, the playlist made
	// once it ends has them all, in order. Whether it is comes from the sender's device (in
	// each file's start message) or, failing that, the offer.
	const received = receivedFiles.get(transfer.offer.id);
	let entry = incomingPlaylists.get(batchId);
	if (!entry) {
		entry = { saving: 0, trackIds: [] };
		incomingPlaylists.set(batchId, entry);
	}
	if (received?.playlist) entry.metadata = received.playlist;
	else if (!entry.metadata && batch.playlist) {
		entry.metadata = { name: batch.playlist, description: '' };
	}
	entry.artwork ??= received?.playlistArtwork;
	entry.saving++;
	const { outcome, trackId } = await saveReceived(
		transfer,
		batch.location,
		batch.folderName,
		onDuplicate,
		true
	);
	entry.saving--;
	entry.trackIds[position] = trackId;
	countBatchResult(batchId, outcome, position);
	void finishIncomingPlaylist(batchId);
}

function countBatchResult(
	batchId: string,
	result: 'imported' | 'skipped' | 'failed',
	position: number
) {
	updateIncomingBatch(batchId, (b) => ({
		...b,
		[result]: b[result] + 1,
		results: Object.assign([...b.results], { [position]: result })
	}));
	const batch = findIncomingBatch(batchId);
	if (
		batch?.status === 'receiving' &&
		batch.imported + batch.skipped + batch.failed >= batch.count
	) {
		endIncomingBatch(batchId, 'done');
	}
}

/**
 * Stop a batch another device is sending to this one. Tracks already added stay in the
 * library; the sender is told it was canceled.
 */
export async function cancelIncomingBatch(id: string) {
	const batch = findIncomingBatch(id);
	if (batch?.status !== 'receiving' || batch.cancelling) return;
	const current = batch.transferId;
	// Between two files: the next offer is turned down when it comes (see receiveBatchOffer).
	if (!current) {
		endIncomingBatch(id, 'cancelled', CANCELLED_BY_YOU);
		return;
	}
	updateIncomingBatch(id, (b) => ({ ...b, cancelling: true }));
	await cancelIncoming(current);

	// The server's peer:ended usually ends the batch first (in incomingItemEnded). If
	// cancelIncoming finished without it, end it here.
	const now = findIncomingBatch(id);
	if (!now?.cancelling || now.transferId !== current) return;
	const transfer = get(incomingTransfers).find((t) => t.offer.id === current);
	if (!transfer) endIncomingBatch(id, 'cancelled', CANCELLED_BY_YOU);
	else if (!transfer.cancelling) updateIncomingBatch(id, (b) => ({ ...b, cancelling: false }));
}

/** Take a batch sent to this device off the screen once it has ended. */
export function closeIncomingBatch(id: string) {
	const batch = findIncomingBatch(id);
	if (batch && isBatchOver(batch)) {
		incomingBatches.update((list) => list.filter((b) => b.id !== id));
	}
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
 * Offer a track's file (`data`, described by `file`) to another of this account's devices,
 * called `label` in notices. `data` and the track's metadata are kept with the offer and sent
 * once it's accepted. On success the offer is tracked in `outgoingOffers` and a "waiting"
 * notice stays up until the other device answers. On failure the caller decides how to show
 * the error.
 */
export async function sendOffer(
	target: OwnDevice,
	file: TransferFile,
	data: Blob,
	song: Song,
	label = file.name,
	batch?: TransferBatch,
	{ album, playlist }: TracksCollection = {}
): Promise<TransferReply> {
	// Send plain metadata without the cover Blob or this device's file location.
	const track: TransferredTrackMetadata = JSON.parse(
		JSON.stringify(song, (key, value) => (key === 'image' || key === 'source' ? undefined : value))
	);

	const reply = await request((client, ack) =>
		client
			.timeout(OFFER_TIMEOUT_MS)
			.emit('peer:offer', { targetDeviceId: target.id, file, ...(batch ? { batch } : {}) }, ack)
	);
	if (!reply.ok) return reply;

	const { transferId } = reply;
	outgoingOffers.update((offers) => [
		...offers,
		{
			transferId,
			target,
			file,
			data,
			track,
			album,
			playlist,
			label,
			status: 'pending',
			sent: 0,
			batchId: batch?.id
		}
	]);
	// A batch shows one notice for all its files (see sendBatch).
	if (batch) return reply;
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
	// Already delivered: the server has nothing left to cancel.
	if (offer.completed) {
		removeOutgoing(transferId);
		return;
	}
	updateOutgoing(transferId, (o) => ({ ...o, cancelling: true }));

	// The server's peer:ended (handled in endOutgoing) usually removes it before this returns.
	const reply = await cancelTransfer(transferId);
	const now = get(outgoingOffers).find((o) => o.transferId === transferId);
	if (!now?.cancelling) return;
	if (reply.ok) {
		recordOutgoing(offer, 'cancelled', CANCELLED_BY_YOU);
		removeOutgoing(transferId);
		toast.dismiss(transferId);
	} else {
		updateOutgoing(transferId, (o) => ({ ...o, cancelling: false }));
		toast.error(`Couldn't cancel: ${reply.error}`);
	}
}

/** Whether the receiver reported an accepted offer complete (it checked the whole file). */
export function isSent(offer: OutgoingOffer): boolean {
	return offer.status === 'accepted' && !!offer.completed;
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
