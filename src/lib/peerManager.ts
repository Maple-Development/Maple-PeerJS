import { Peer, type DataConnection } from 'peerjs';
import type { PeerMessage } from './types';

export const CHUNK_SIZE = 16 * 1024; // may change these later depending on speed
export const SEND_WINDOW = 256 * 1024;

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

const CONNECT_TIMEOUT = 15_000;

export async function connectToPeer(peer: Peer, peerId: string) : Promise<DataConnection> {
    if (!peer.open) {
        throw new Error('Wait for the peer to open before connecting')
    }

    const conn = peer.connect(peerId, {
        reliable: true,
        serialization: 'binary'
    });

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Timed out connecting to the peer'))
        }, CONNECT_TIMEOUT);

        function cleanup() {
            clearTimeout(timeout);
            conn.off('open', onOpen);
            conn.off('error', fail);
            conn.off('close', onClose);
        }

        function onOpen() {
            cleanup();
            resolve(conn);
        }

        function fail(error: Error) {
            cleanup();
            conn.close();
            reject(error);
        }

        function onClose() {
            fail(new Error('Connection closed'))
        }
        
        conn.on('open', onOpen);
        conn.on('error', fail);
        conn.on('close', onClose);
    })
}