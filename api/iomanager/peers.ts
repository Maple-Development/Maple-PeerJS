import type { Database } from "../storage/sqlite.js";
import type { OwnDevice, TransferOffer } from "../types/peer.js";
import type { MapleServer, MapleSocket } from "../types/socket.js";
import { activeSession } from "../auth/session.js";
import { accountRoom } from "./io.js";
import { randomUUID } from "node:crypto";
import { transferRequestSchema, deviceRegistrationSchema } from "../validation/peer.js";

interface ConnectedDevice {
	device: OwnDevice;
	socketIds: Set<string>;
}

interface PendingOffer {
	accountId: string;
	offer: TransferOffer;
	senderSocketId: string;
	targetSocketId: string;
}

export class PeerManager {
	private accounts = new Map<string, Map<string, ConnectedDevice>>();
    private offers = new Map<string, PendingOffer>();
    
    constructor(private io: MapleServer, private db: Database) {}

    connect(client: MapleSocket) {
		const user = client.data.user;
		let registeredDeviceId: string | undefined;

		const publish = () => {
			const accountDevices = this.accounts.get(user.id);
			let devices: OwnDevice[] = [];

			if (accountDevices) {
				devices = Array.from(
					accountDevices.values(),
					(entry) => entry.device
				);
			}

			const room = accountRoom(user.id);
			this.io.to(room).emit('peer:devices', devices);
		};

        client.on('peer:register', (registration) => {
			const sessionExpiresAt = activeSession(this.db, user);
			if (sessionExpiresAt === undefined) {
				client.disconnect(true);
				return;
			}

			const parsed = deviceRegistrationSchema.safeParse(registration);
			if (!parsed.success) {
				return;
			}

			const { id, name } = parsed.data;

			if (registeredDeviceId !== undefined && registeredDeviceId !== id) {
				return;
			}

			let accountDevices = this.accounts.get(user.id);
			if (!accountDevices) {
				accountDevices = new Map();
				this.accounts.set(user.id, accountDevices);
			}

			let entry = accountDevices.get(id);
			if (!entry) {
				entry = {
					device: { id, name },
					socketIds: new Set()
				};

				accountDevices.set(id, entry);
			} else if (registeredDeviceId === id) {
				entry.device.name = name;
			}

			entry.socketIds.add(client.id);
			registeredDeviceId = id;
			publish();
		});

        client.on('peer:offer', (request, reply) => {
			if (typeof reply !== 'function') {
				return;
			}

			const sessionExpiresAt = activeSession(this.db, user);
			if (sessionExpiresAt === undefined) {
				reply({ ok: false, error: 'Your session has expired.' });
				client.disconnect(true);
				return;
			}

            const parsed = transferRequestSchema.safeParse(request);
		    if (!parsed.success) {
				reply({ ok: false, error: 'Invalid transfer request.' });
				return;
			}

			if (registeredDeviceId === undefined) {
				reply({ ok: false, error: 'Register this device first.' });
				return;
			}

			const accountDevices = this.accounts.get(user.id);
			const sender = accountDevices?.get(registeredDeviceId);
			const target = accountDevices?.get(parsed.data.targetDeviceId);

			if (!sender) {
				reply({ ok: false, error: 'Register this device first.' });
				return;
			}

			if (!target) {
				reply({ ok: false, error: 'The target device is unavailable.' });
				return;
			}

            if (sender.device.id === target.device.id) {
				reply({ ok: false, error: 'Choose another device' });
				return;
			}

			for (const pending of this.offers.values()) {
				if (
					pending.accountId === user.id &&
					pending.offer.sender.id === sender.device.id
				) {
					reply({ ok: false, error: 'You already have a pending offer.' });
					return;
				}
			}

			const targetSocketId = target.socketIds.values().next().value;
			if (targetSocketId === undefined) {
				reply({ ok: false, error: 'The target device is unavailable.' });
				return;
			}

			const offer: TransferOffer = {
				id: randomUUID(),
				sender: { ...sender.device },
				targetDeviceId: target.device.id,
				file: parsed.data.file
			};

			this.offers.set(offer.id, {
				accountId: user.id,
				offer,
				senderSocketId: client.id,
				targetSocketId
			});

			this.io.to(targetSocketId).emit('peer:incoming', offer);
			reply({ ok: true, transferId: offer.id });
		});

        client.on('disconnect', () => {
			for (const [offerId, pending] of this.offers) {
				const isSender = pending.senderSocketId === client.id;
				const isRecipient = pending.targetSocketId === client.id;

				if (isSender || isRecipient) {
					this.offers.delete(offerId);
				}
			}

			if (registeredDeviceId === undefined) {
				return;
			}

			const accountDevices = this.accounts.get(user.id);
			const entry = accountDevices?.get(registeredDeviceId);

			if (!accountDevices || !entry) {
				return;
			}

			entry.socketIds.delete(client.id);

			if (entry.socketIds.size > 0) {
				return;
			}

			accountDevices.delete(registeredDeviceId);

			if (accountDevices.size === 0) {
				this.accounts.delete(user.id);
			}

			publish();
		});
    }
}