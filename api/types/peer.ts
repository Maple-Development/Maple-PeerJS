export interface OwnDevice {
    id: string;
    name: string;
}

export interface PeerClientEvents {
	'peer:register': (name: string) => void;
}

export interface PeerServerEvents {
	'peer:devices': (devices: OwnDevice[]) => void;
}