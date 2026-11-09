export interface OwnDevice {
    /** Persistent per-browser ID (shared by all of that browser's tabs), not a socket ID. */
    id: string;
    name: string;
    /** True once the user picked the name; false for a server-assigned "Device N". */
    custom: boolean;
}

export interface PeerClientEvents {
	/** An empty name means "keep the current name", or get the next "Device N" if new. */
	'peer:register': (deviceId: string, name: string) => void;
	'peer:rename': (deviceId: string, name: string) => void;
}

export interface PeerServerEvents {
	'peer:devices': (devices: OwnDevice[]) => void;
}