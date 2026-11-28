import type { Database } from "../storage/sqlite.js";
import type { OwnDevice, TransferOffer, TransferEnded } from "../types/peer.js";
import type { MapleServer, MapleSocket } from "../types/socket.js";
import { activeSession } from "../auth/session.js";
import { accountRoom } from "./io.js";
import { randomUUID } from "node:crypto";
import { transferRequestSchema, deviceRegistrationSchema, transferDecisionSchema, transferCancelSchema, transferReadySchema, transferFinishSchema } from "../validation/peer.js";

const OFFER_EXPIRY_MS = 300_000; // 5 minutes until expiration

interface ConnectedDevice {
	device: OwnDevice;
	socketIds: Set<string>;
}

interface PendingOffer {
	accountId: string;
	offer: TransferOffer;
	senderSocketId: string;
	targetSocketId: string;
	targetPeerId?: string;
	status: 'pending' | 'accepted';
	expiryTimer: ReturnType<typeof setTimeout>;
}

export class PeerManager {
	private accounts = new Map<string, Map<string, ConnectedDevice>>();
    private offers = new Map<string, PendingOffer>();
    
    constructor(private io: MapleServer, private db: Database) {}

	private endTransfer(transferId: string, reason: TransferEnded['reason']): void {
		const pending = this.offers.get(transferId);
		if (!pending) {
			return;
		}

		clearTimeout(pending.expiryTimer);
		this.offers.delete(transferId);

		this.io
			.to(pending.senderSocketId)
			.to(pending.targetSocketId)
			.emit('peer:ended', { transferId, reason });
	}

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

			const { id, name, kind } = parsed.data;

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
					device: { id, name, kind },
					socketIds: new Set()
				};

				accountDevices.set(id, entry);
			} else if (registeredDeviceId === id) {
				entry.device.name = name;
				entry.device.kind = kind;
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

			const expiryTimer = setTimeout(() => {
				if (this.offers.get(offer.id)?.status === 'pending') {
					this.endTransfer(offer.id, 'expired');
				}
			}, OFFER_EXPIRY_MS);
			
			this.offers.set(offer.id, {
				accountId: user.id,
				offer,
				senderSocketId: client.id,
				targetSocketId,
				status: 'pending',
				expiryTimer
			});

			this.io.to(targetSocketId).emit('peer:incoming', offer);
			reply({ ok: true, transferId: offer.id });
		});

		client.on('peer:respond', (decision, reply) => {
			if (typeof reply !== 'function') {
				return;
			}

			const sessionExpiresAt = activeSession(this.db, user);
			if (sessionExpiresAt === undefined) {
				reply({ ok: false, error: 'Your session has expired.' });
				client.disconnect(true);
				return;
			}
		
			const parsed = transferDecisionSchema.safeParse(decision);
			if (!parsed.success) {
				reply({ ok: false, error: 'Invalid transfer decision.' });
				return;
			}

			const { transferId, accepted } = parsed.data;
			const pending = this.offers.get(transferId);

			if (!pending || pending.accountId !== user.id) {
				reply({ ok: false, error: 'Transfer offer not found.' });
				return;
			}
		
			if (pending.targetSocketId !== client.id) {
				reply({ ok: false, error: 'This offer belongs to another tab.' });
				return;
			}
		
			if (pending.status !== 'pending') {
				reply({ ok: false, error: 'This offer has already been accepted.' });
				return;
			}

			if (accepted) {
				const sender = this.io.sockets.sockets.get(pending.senderSocketId);
		
				if (!sender || !sender.connected || !client.connected) {
					this.endTransfer(transferId, 'disconnected');
					reply({ ok: false, error: 'A transfer participant is offline.' });
					return;
				}
		
				const senderSessionExpiresAt = activeSession(this.db, sender.data.user);
				if (sender.data.user.id !== user.id || senderSessionExpiresAt === undefined) {
					this.endTransfer(transferId, 'unauthorized');
					reply({ ok: false, error: 'The sender is no longer authorized.' });
					return;
				}
		
				clearTimeout(pending.expiryTimer);
				pending.status = 'accepted';
			} else {
				clearTimeout(pending.expiryTimer);
				this.offers.delete(transferId);
			}

			this.io.to(pending.senderSocketId).emit('peer:decision', {
				transferId,
				accepted
			});

			reply({ ok: true, transferId });
		})

		client.on('peer:ready', (request, reply) => {
			if (typeof reply !== 'function') {
				return;
			}

			if (activeSession(this.db, user) === undefined) {
				reply({ ok: false, error: 'Your session has expired.' });
				client.disconnect(true);
				return;
			}

			const parsed = transferReadySchema.safeParse(request);
			if (!parsed.success) {
				reply({ ok: false, error: 'Invalid transfer readiness request.' });
				return;
			}

			const { transferId, peerId } = parsed.data;
			const pending = this.offers.get(transferId);

			if (!pending || pending.accountId !== user.id) {
				reply({ ok: false, error: 'Transfer offer not found.' });
				return;
			}
		
			if (pending.targetSocketId !== client.id || pending.status !== 'accepted') {
				reply({ ok: false, error: 'Only the tab that accepted can mark this transfer ready.' });
				return;
			}
		
			if (pending.targetPeerId !== undefined) {
				if (pending.targetPeerId === peerId) {
					reply({ ok: true, transferId });
				} else {
					reply({ ok: false, error: 'This transfer already has a receiving peer.' });
				}
				return;
			}

			const sender = this.io.sockets.sockets.get(pending.senderSocketId);
			if (!sender?.connected) {
				this.endTransfer(transferId, 'disconnected');
				reply({ ok: false, error: 'The sender is offline.' });
				return;
			}

			if (sender.data.user.id !== user.id || activeSession(this.db, sender.data.user) === undefined) {
				this.endTransfer(transferId, 'unauthorized');
				reply({ ok: false, error: 'The sender is no longer authorized.' });
				return;
			}

			pending.targetPeerId = peerId;
			sender.emit('peer:connect', { transferId, peerId });
			reply({ ok: true, transferId });
		});

		client.on('peer:finish', (request, reply) => {
			if (typeof reply !== 'function') {
				return;
			}
		
			if (activeSession(this.db, user) === undefined) {
				reply({ ok: false, error: 'Your session has expired.' });
				client.disconnect(true);
				return;
			}
		
			const parsed = transferFinishSchema.safeParse(request);
			if (!parsed.success) {
				reply({ ok: false, error: 'Invalid transfer outcome.' });
				return;
			}

			const { transferId, outcome } = parsed.data;
			const pending = this.offers.get(transferId);

			if (!pending || pending.accountId !== user.id) {
				reply({ ok: false, error: 'Transfer not found.' });
				return;
			}
		
			const isRecipient = pending.targetSocketId === client.id;
			const isSender = pending.senderSocketId === client.id;
		
			if (!isRecipient && !isSender) {
				reply({ ok: false, error: 'This transfer belongs to another tab.' });
				return;
			}
		
			if (pending.status !== 'accepted') {
				reply({ ok: false, error: 'This offer has not been accepted.' });
				return;
			}

			if (outcome === 'completed' && (!isRecipient || pending.targetPeerId === undefined)) {
				reply({ ok: false, error: 'Only the ready receiving tab can report completion.' });
				return;
			}

			this.endTransfer(transferId, outcome);
			reply({ ok: true, transferId });
		});

		client.on('peer:cancel', (request, reply) => {
			if (typeof reply !== 'function') {
				return;
			}
		
			if (activeSession(this.db, user) === undefined) {
				reply({ ok: false, error: 'Your session has expired.' });
				client.disconnect(true);
				return;
			}
		
			const parsed = transferCancelSchema.safeParse(request);
			if (!parsed.success) {
				reply({ ok: false, error: 'Invalid cancellation request.' });
				return;
			}

			const { transferId } = parsed.data;
			const pending = this.offers.get(transferId);

			if (!pending || pending.accountId !== user.id) {
				reply({ ok: false, error: 'Transfer offer not found.' });
				return;
			}

			const isParticipant = pending.senderSocketId === client.id || pending.targetSocketId === client.id;
			if (!isParticipant) {
				reply({ ok: false, error: 'This offer belongs to another tab.' });
				return;
			}

			this.endTransfer(transferId, 'cancelled');
			reply({ ok: true, transferId });
		})

        client.on('disconnect', () => {
			for (const [transferId, pending] of this.offers) {
				const isParticipant =
					pending.senderSocketId === client.id ||
					pending.targetSocketId === client.id;
			
				if (isParticipant) {
					this.endTransfer(transferId, 'disconnected');
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