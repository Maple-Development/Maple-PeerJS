export interface OwnDevice {
    id: string;
    name: string;
}

export interface TransferFile {
    name: string
    size: number
    type: string
}

export interface TransferRequest {
    targetDeviceId: string
    file: TransferFile
}

export interface TransferOffer {
    id: string
    sender: OwnDevice
    targetDeviceId: string
    file: TransferFile
}

export type TransferReply = | { ok: true; transferId: string } | { ok: false; error: string};

export interface PeerClientEvents {
	'peer:register': (name: string) => void;
    'peer:offer': (
        request: TransferRequest,
        reply: (result: TransferReply) => void
    ) => void
}

export interface PeerServerEvents {
	'peer:devices': (devices: OwnDevice[]) => void;
    'peer:incoming': (offer: TransferOffer) => void;
}