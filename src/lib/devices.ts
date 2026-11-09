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

/** Offers other devices have sent to this one, newest last. */
export const incomingOffers = writable<TransferOffer[]>([]);

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

	client.on('peer:devices', (list) => devices.set(list));

	client.on('peer:incoming', (offer) => {
		incomingOffers.update((offers) => [...offers, offer]);
		// The server has no accept/decline step yet, so this is only a notice for now.
		toast.info(`${offer.sender.name} wants to send you a track`, {
			description: `${offer.file.name} (${formatSize(offer.file.size)})`
		});
	});

	client.on('disconnect', () => {
		devices.set([]);
		// The server drops pending offers when either side disconnects.
		incomingOffers.set([]);
	});
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Ask the server to offer a file to another of this account's devices. */
export function sendOffer(targetDeviceId: string, file: TransferFile): Promise<TransferReply> {
	const client = socket;
	if (!client?.connected) {
		return Promise.resolve({ ok: false, error: 'Not connected.' });
	}
	return new Promise((resolve) => {
		const timer = setTimeout(
			() => resolve({ ok: false, error: 'The server did not respond.' }),
			OFFER_TIMEOUT_MS
		);
		client.emit('peer:offer', { targetDeviceId, file }, (reply) => {
			clearTimeout(timer);
			resolve(reply);
		});
	});
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
