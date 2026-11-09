import type { Database } from "../storage/sqlite.js";
import type { OwnDevice } from "../types/peer.js";
import type { MapleServer, MapleSocket } from "../types/socket.js";
import { activeSession } from "../auth/session.js";
import { accountRoom } from "./io.js";

export class PeerManager {
	private accounts = new Map<string, Map<string, OwnDevice>>();
    
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

        client.on('disconnect', () => {
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