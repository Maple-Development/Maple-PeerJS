export interface OwnDevice {
    id: string;
    name: string;
}

export interface TransferFile {
    name: string
    size: number
    type: string
}

/**
 * Set when the file is one of several sent together. The receiver accepts the first offer of a
 * batch and its device then accepts the rest itself, one at a time, as they arrive.
 */
export interface TransferBatch {
    id: string
    /** This file's place in the batch, from 0. */
    index: number
    /** How many files the batch has in all. */
    count: number
    /** Bytes of this file and every file after it in the batch. */
    size: number
}

export interface TransferRequest {
    targetDeviceId: string
    file: TransferFile
    batch?: TransferBatch
}

export interface TransferOffer {
    id: string
    sender: OwnDevice
    targetDeviceId: string
    file: TransferFile
    batch?: TransferBatch
}

export interface TransferDecision {
    transferId: string
    accepted: boolean
}

export interface TransferFinish {
    transferId: string
    outcome: 'completed' | 'failed'
}

export interface TransferReady {
    transferId: string
    peerId: string
}

export interface TransferCancel {
	transferId: string;
}

export interface TransferEnded {
	transferId: string;
	reason: 'cancelled' | 'disconnected' | 'unauthorized' | 'expired' | 'completed' | 'failed';
}

export interface DeviceRegistration {
	id: string;
	name: string;
}

export type TransferReply = | { ok: true; transferId: string } | { ok: false; error: string};

export interface PeerClientEvents {
	'peer:register': (device: DeviceRegistration) => void;
    'peer:offer': (
        request: TransferRequest,
        reply: (result: TransferReply) => void
    ) => void
    'peer:respond': (
        decision: TransferDecision,
        reply: (result: TransferReply) => void
    ) => void
    'peer:cancel': (
        request: TransferCancel,
        reply: (result: TransferReply) => void
    ) => void;
    'peer:ready': (
        request: TransferReady,
        reply: (result: TransferReply) => void
    ) => void
    'peer:finish': (
        request: TransferFinish,
        reply: (result: TransferReply) => void
    ) => void
}

export interface PeerServerEvents {
	'peer:devices': (devices: OwnDevice[]) => void;
    'peer:incoming': (offer: TransferOffer) => void;
    'peer:decision': (decision: TransferDecision) => void;
    'peer:ended': (event: TransferEnded) => void;
    'peer:connect': (event: TransferReady) => void;
}