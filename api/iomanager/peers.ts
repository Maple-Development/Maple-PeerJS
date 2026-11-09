import type { Database } from "../storage/sqlite.js";
import type { OwnDevice, TransferOffer } from "../types/peer.js";
import type { MapleServer, MapleSocket } from "../types/socket.js";
import { activeSession } from "../auth/session.js";
import { accountRoom } from "./io.js";
import { randomUUID } from "node:crypto";
import { transferRequestSchema } from "../validation/peer.js";

export class PeerManager {
	private accounts = new Map<string, Map<string, OwnDevice>>();
    private offers = new Map<string, TransferOffer>();
    
    constructor(private io: MapleServer, private db: Database) {}

    connect(client: MapleSocket) {
        const user = client.data.user;

        const publish = () => {
            const accountDevices = this.accounts.get(user.id);
            let devices: OwnDevice[] = [];

            if (accountDevices) {
                devices = Array.from(accountDevices.values());
            }

            const room = accountRoom(user.id)

            this.io.to(room).emit('peer:devices', devices)
        };

        client.on('peer:register', (name) => {
            const sessionExpiresAt = activeSession(this.db, user)
            if (sessionExpiresAt === undefined) {
                client.disconnect(true);
                return;
            }
            if (typeof name !== 'string') {
				return;
			}

            const deviceName = name.trim();
            if (deviceName.length === 0 || deviceName.length > 40) {
				return;
			}

            let accountDevices = this.accounts.get(user.id)
            if (!accountDevices) {
                accountDevices = new Map();
                this.accounts.set(user.id, accountDevices)
            }

            const device: OwnDevice = {
                id: client.id,
                name: deviceName
            }

            accountDevices.set(client.id, device)
            publish();
        });

        client.on('peer:offer', (request, reply) => {
            if (typeof reply !== 'function') {
                return;
            }

            const sessionExpiresAt = activeSession(this.db, user);
            if (sessionExpiresAt === undefined) {
                reply({ ok: false, error: 'Your session has expired' });
                client.disconnect(true);
                return;
            }

            const parsed = transferRequestSchema.safeParse(request);
            if (!parsed.success) {
                reply({ ok: false, error: 'Invalid Transfer request' });
                return;
            }

            const accountDevices = this.accounts.get(user.id);
            const sender = accountDevices?.get(client.id);
            const target = accountDevices?.get(parsed.data.targetDeviceId);

            if (!sender) {
                reply({ ok: false, error: 'Register this device first' });
                return;
            }

            if (!target) {
                reply({ ok: false, error: 'The target device is unavailable.' });
                return;
            }
        
            if (target.id === sender.id) {
                reply({ ok: false, error: 'Choose another device.' });
                return;
            }

            for (const offer of this.offers.values()) {
                if (offer.sender.id === client.id) {
                    reply({ ok: false, error: 'You already have a pending offer.' });
                    return;
                }
            }

            const offer: TransferOffer = {
                id: randomUUID(),
                sender: {...sender },
                targetDeviceId: target.id,
                file: parsed.data.file
            }

            this.offers.set(offer.id, offer);
            this.io.to(target.id).emit('peer:incoming', offer);

            reply({ ok: true, transferId: offer.id });
        })

        client.on('disconnect', () => {
            for (const [offerId, offer] of this.offers) {
                const isSender = offer.sender.id === client.id;
                const isRecipient = offer.targetDeviceId === client.id;
            
                if (isSender || isRecipient) {
                    this.offers.delete(offerId);
                }
            }
            
            const accountDevices = this.accounts.get(user.id)
            if (!accountDevices) {
                return;
            }

            const deviceRemoved = accountDevices.delete(client.id)
            if (!deviceRemoved) {
                return;
            }

            if (accountDevices.size === 0) {
                this.accounts.delete(user.id);
            }

            publish();
        })
    }
}