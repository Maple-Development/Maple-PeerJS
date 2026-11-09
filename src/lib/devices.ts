import { writable } from 'svelte/store';
import { v4 as uuidv4 } from 'uuid';
import type { OwnDevice } from '$shared/types/peer';
import type { MapleSocket } from './types';

const ID_KEY = 'maple-device-id';
// Only names the user picked are saved. Default "Device N" names are assigned fresh by the
// server on each connection; saving them made browsers collide (several "Device 1"s).
// (The older 'maple-device-name' key stored defaults too, so it's deliberately ignored.)
const NAME_KEY = 'maple-device-custom-name';

/** This account's online devices, as last published by the server. */
export const devices = writable<OwnDevice[]>([]);

/** One ID per browser, shared by all its tabs, so they show up as a single device. */
export function selfDeviceId(): string {
	let id = localStorage.getItem(ID_KEY);
	if (!id) {
		id = uuidv4();
		localStorage.setItem(ID_KEY, id);
	}
	return id;
}

/** Register this browser as a device whenever the socket (re)connects, and track the device list. */
export function watchDevices(client: MapleSocket) {
	const id = selfDeviceId();

	client.on('connect', () => {
		// An empty name lets the server keep the current name, or assign the next "Device N".
		client.emit('peer:register', id, localStorage.getItem(NAME_KEY)?.trim() ?? '');
	});

	client.on('peer:devices', (list) => {
		devices.set(list);
		// Keep this device's name across reconnects, including renames made from another device.
		const self = list.find((d) => d.id === id);
		if (self?.custom) localStorage.setItem(NAME_KEY, self.name);
		else if (self) localStorage.removeItem(NAME_KEY);
	});

	client.on('disconnect', () => devices.set([]));
}
