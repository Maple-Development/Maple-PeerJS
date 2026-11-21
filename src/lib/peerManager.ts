import { Peer, type DataConnection } from 'peerjs';
import type { PeerMessage, AckMessage } from './types';

export const CHUNK_SIZE = 16 * 1024; // may change these later depending on speed
export const SEND_WINDOW = 256 * 1024;

const CONNECT_TIMEOUT = 15_000;

export function createPeer(serverUrl: string) {
    const url = new URL(serverUrl);
    const secure = url.protocol === 'https:';

    return new Peer({
        host: url.hostname,
        port: url.port ? Number(url.port) : secure ? 443 : 80,
        path: url.pathname,
        secure: secure
    })
}

export async function connectToPeer(peer: Peer, peerId: string) : Promise<DataConnection> {
    if (!peer.open) {
        throw new Error('Wait for the peer to open before connecting')
    }

    const conn = peer.connect(peerId, {
        reliable: true,
        serialization: 'binary'
    });

    if (conn.open) {
        return conn;
    }

    try {
        await waitOnConnection(conn, 'open', 'Timed out connecting to the peer');
        return conn;
    } catch (error) {
        conn.close();
        throw error;
    }
}

export async function sendStart(
    conn: DataConnection,
    transferId: string,
    size: number
): Promise<void> {
    if (!conn.open) {
        throw new Error('Connection is not open');
    }

    const message: PeerMessage = {
        type: 'start',
        transferId,
        size,
        chunkSize: CHUNK_SIZE,
        sendWindow: SEND_WINDOW
    };

    const ackPromise = waitForAck(conn, 0)

    try {
        await conn.send(message);
        await ackPromise;
    } catch (error) {
        ackPromise.catch(() => {});
        throw error;
    }
}

// wait for an ack
export function waitForAck(conn: DataConnection, expectedOffset?: number): Promise<AckMessage> {
	return waitOnConnection<AckMessage>(
		conn,
		'data',
		'The receiver did not acknowledge the message.',
		(data) => isAck(data) && (expectedOffset === undefined || data.nextOffset === expectedOffset)
	);
}

// ensure it's an ack
function isAck(data: unknown): data is AckMessage {
	if (typeof data !== 'object' || data === null) return false;
	const msg = data as Record<string, unknown>;
	return msg.type === 'ack' && typeof msg.nextOffset === 'number';
}

function waitOnConnection<T = void>(
    conn: DataConnection,
    event: 'open' | 'data',
    timeoutMessage: string,
    match?: (data: unknown) => boolean
): Promise<T> {
    return new Promise((resolve, reject) => {
        function cleanup() {
            clearTimeout(timer);
            conn.off(event, onEvent);
            conn.off('error', fail);
            conn.off('close', onClose);
        }

        function fail(error: unknown) {
            cleanup();
            reject(error);
        }

        function onClose() {
            fail(new Error('Connection closed'));
        }

        function onEvent(data?: unknown) {
            if (match && !match(data)) return;
            cleanup();
            resolve(data as T);
        }

        const timer = setTimeout(() => fail(new Error(timeoutMessage)), CONNECT_TIMEOUT);
        conn.on(event, onEvent);
        conn.on('error', fail);
        conn.on('close', onClose);
    })
}