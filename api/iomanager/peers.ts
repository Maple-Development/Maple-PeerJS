import type { Database } from "../storage/sqlite.js";
import type { OwnDevice } from "../types/peer.js";
import type { MapleServer, MapleSocket } from "../types/socket.js";
import { activeSession } from "../auth/session.js";
import { accountRoom } from "./io.js";

const MAX_NAME = 40;
const MAX_DEVICE_ID = 64;

// One browser is one device, however many tabs (sockets) it has open.
interface DeviceEntry {
    device: OwnDevice;
    sockets: Set<string>;
}

type AccountDevices = Map<string, DeviceEntry>;

// "Device N", where N is one more than the number of devices already online,
// skipping ahead if that name is taken (e.g. after a device in the middle disconnects).
function nextDefaultName(accountDevices: AccountDevices): string {
    const taken = new Set(Array.from(accountDevices.values(), (e) => e.device.name));
    let n = accountDevices.size + 1;
    while (taken.has(`Device ${n}`)) n++;
    return `Device ${n}`;
}

export class PeerManager {
	private accounts = new Map<string, AccountDevices>();

    constructor(private io: MapleServer, private db: Database) {}

    connect(client: MapleSocket) {
        const user = client.data.user;
        // The browser device this socket registered as, if any.
        let registeredDeviceId: string | undefined;

        const publish = () => {
            const accountDevices = this.accounts.get(user.id);
            let devices: OwnDevice[] = [];

            if (accountDevices) {
                devices = Array.from(accountDevices.values(), (e) => e.device);
            }

            const room = accountRoom(user.id)

            this.io.to(room).emit('peer:devices', devices)
        };

        // Detach this socket from its device; drop the device once its last tab is gone.
        const leave = (): boolean => {
            const deviceId = registeredDeviceId;
            registeredDeviceId = undefined;
            if (deviceId === undefined) {
                return false;
            }

            const accountDevices = this.accounts.get(user.id);
            const entry = accountDevices?.get(deviceId);
            if (!accountDevices || !entry) {
                return false;
            }

            entry.sockets.delete(client.id);
            if (entry.sockets.size > 0) {
                console.log(`[PEER] Tab closed on "${entry.device.name}" (${entry.sockets.size} open)`);
                return false;
            }

            console.log(`[PEER] Device left: "${entry.device.name}" (${deviceId.slice(0, 8)})`);
            accountDevices.delete(deviceId);
            if (accountDevices.size === 0) {
                this.accounts.delete(user.id);
            }
            return true;
        };

        const sessionActive = () => {
            if (activeSession(this.db, user) === undefined) {
                client.disconnect(true);
                return false;
            }
            return true;
        };

        client.on('peer:register', (deviceId, name) => {
            if (!sessionActive()) {
                return;
            }
            if (typeof deviceId !== 'string' || typeof name !== 'string') {
				return;
			}
            if (deviceId.length === 0 || deviceId.length > MAX_DEVICE_ID) {
                return;
            }

            const deviceName = name.trim();
            if (deviceName.length > MAX_NAME) {
				return;
			}

            if (registeredDeviceId !== deviceId) {
                leave();
            }

            let accountDevices = this.accounts.get(user.id)
            if (!accountDevices) {
                accountDevices = new Map();
                this.accounts.set(user.id, accountDevices)
            }

            let entry = accountDevices.get(deviceId);
            if (!entry) {
                entry = {
                    device: {
                        id: deviceId,
                        name: deviceName || nextDefaultName(accountDevices),
                        custom: deviceName.length > 0
                    },
                    sockets: new Set()
                };
                accountDevices.set(deviceId, entry);
            } else if (deviceName.length > 0) {
                entry.device.name = deviceName;
                entry.device.custom = true;
            }

            if (!entry.sockets.has(client.id)) {
                entry.sockets.add(client.id);
                console.log(
                    entry.sockets.size === 1
                        ? `[PEER] Device joined: "${entry.device.name}" (${deviceId.slice(0, 8)}), ${accountDevices.size} online`
                        : `[PEER] Tab opened on "${entry.device.name}" (${entry.sockets.size} open)`
                );
            }
            registeredDeviceId = deviceId;
            publish();
        });

        client.on('peer:rename', (deviceId, name) => {
            if (!sessionActive()) {
                return;
            }
            if (typeof deviceId !== 'string' || typeof name !== 'string') {
                return;
            }

            const deviceName = name.trim();
            if (deviceName.length === 0 || deviceName.length > MAX_NAME) {
                return;
            }

            // Only devices on this account can be renamed.
            const entry = this.accounts.get(user.id)?.get(deviceId);
            if (!entry) {
                return;
            }

            entry.device.name = deviceName;
            entry.device.custom = true;
            publish();
        });

        client.on('disconnect', () => {
            if (leave()) {
                publish();
            }
        })
    }
}
