import { Peer, type DataConnection } from 'peerjs';
import {
	MAX_ARTWORK_BYTES,
	MAX_PLAYLIST_DESCRIPTION,
	type PeerMessage,
	type AckMessage,
	type StartMessage,
	type TransferredAlbumMetadata,
	type TransferredArtwork,
	type TransferredPlaylistMetadata,
	type TransferredTrackMetadata
} from './types';
import { createSHA256 } from 'hash-wasm';
import * as z from 'zod';

export const CHUNK_SIZE = 16 * 1024; // may change these later depending on speed
export const SEND_WINDOW = 256 * 1024;

const CONNECT_TIMEOUT = 15_000;

const transferredTrackSchema = z.object({
	id: z.uuid(),
	title: z.string(),
	artist: z.string(),
	album: z.string(),
	year: z.number(),
	genre: z.string().nullish().transform((value) => value ?? undefined),
	fileName: z.string(),
	duration: z.number().nonnegative(),
	trackNumber: z.number(),
	disk: z.number(),
	ext: z.string().regex(/^[a-z0-9]{1,10}$/i),
	lyrics: z.array(z.object({
		text: z.string(),
		time: z.number().nullish().transform((value) => value ?? undefined)
	})).nullish().transform((value) => value ?? undefined)
});

const albumSchema = z.object({
	name: z.string(),
	artist: z.string(),
	year: z.number(),
	genre: z.string().nullish().transform((value) => value ?? undefined)
});

/** A playlist's created or modified date (ms since the epoch), if it's a real one. */
const playlistDate = z
	.number()
	.int()
	.positive()
	.max(Number.MAX_SAFE_INTEGER)
	.nullish()
	.catch(undefined)
	.transform((value) => value ?? undefined);

const playlistSchema = z.object({
	name: z.string().trim().min(1).max(255),
	description: z.string().max(MAX_PLAYLIST_DESCRIPTION),
	createdAt: playlistDate,
	modifiedAt: playlistDate
});

/** The cover in a start message, if it's a real image within the size limit. */
function parseArtwork(value: unknown): TransferredArtwork | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const { bytes, type } = value as Record<string, unknown>;
	if (typeof type !== 'string' || !/^(image\/[a-z0-9.+-]{1,100})?$/i.test(type)) return undefined;
	const buffer =
		bytes instanceof ArrayBuffer
			? bytes
			: ArrayBuffer.isView(bytes)
				? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice().buffer
				: undefined;
	if (!buffer || buffer.byteLength === 0 || buffer.byteLength > MAX_ARTWORK_BYTES) return undefined;
	return { bytes: buffer, type };
}

export function createPeer(serverUrl: string) {
    const url = new URL(serverUrl);
    const secure = url.protocol === 'https:';

    const peer = new Peer({
        host: url.hostname,
        port: url.port ? Number(url.port) : secure ? 443 : 80,
        path: url.pathname,
        secure: secure
    });

    peer.on('error', (error) => console.error('[PeerJS] peer error:', error));

    return peer;
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
    size: number,
    track: TransferredTrackMetadata,
    {
        album,
        playlist
    }: {
        /** The album the track is sent as part of, and its cover. */
        album?: { metadata: TransferredAlbumMetadata; artwork?: TransferredArtwork };
        /** The playlist the track is sent as part of, and its cover. */
        playlist?: { metadata: TransferredPlaylistMetadata; artwork?: TransferredArtwork };
    } = {}
): Promise<void> {
    if (!conn.open) {
        throw new Error('Connection is not open');
    }

    const message: PeerMessage = {
        type: 'start',
        transferId,
        size,
        chunkSize: CHUNK_SIZE,
        sendWindow: SEND_WINDOW,
        track,
        ...(album ? { album: album.metadata } : {}),
        ...(album?.artwork ? { artwork: album.artwork } : {}),
        ...(playlist ? { playlist: playlist.metadata } : {}),
        ...(playlist?.artwork ? { playlistArtwork: playlist.artwork } : {})
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

export async function sendChunks(
    conn: DataConnection,
    file: Blob,
    onProgress?: (writtenBytes: number) => void
): Promise<string> {
    const hash = await createSHA256();
    let sentOffset = 0;
    let ackedOffset = 0;

    function onAck(data: unknown) {
        if (!isAck(data)) return;

        const { nextOffset } = data;
        if (!Number.isSafeInteger(nextOffset) || nextOffset <= ackedOffset || nextOffset > sentOffset) return;

        ackedOffset = nextOffset;
        onProgress?.(ackedOffset);
    }

    async function waitForProgress(condition: () => boolean) {
        if (!conn.open) {
            throw new Error('Connection is not open');
        }
        if (condition()) return;

        await waitOnConnection(conn, 'data', 'Timed out waiting for progress', condition);
    }

    conn.on('data', onAck);

    try {
        while (sentOffset < file.size) {
            const offset = sentOffset;
            const end = Math.min(offset + CHUNK_SIZE, file.size);

            await waitForProgress(() => end - ackedOffset <= SEND_WINDOW);

            const bytes = await file.slice(offset, end).arrayBuffer();
            if (!conn.open) throw new Error('Connection closed mid chunk');
            
            hash.update(new Uint8Array(bytes));

            sentOffset = end;
            const message: PeerMessage = {
                type: 'chunk',
                offset,
                bytes,
            };
            await conn.send(message);
        }

        await waitForProgress(() => ackedOffset === file.size);
        return hash.digest('hex');
    } finally {
        conn.off('data', onAck);
    }
}

export async function sendEnd(
    conn: DataConnection,
    sha256: string
): Promise<void> {
    if (!conn.open) throw new Error('Connection is not open');

    // send checksum to make sure everything was received correctly
    const message: PeerMessage = {
        type: 'end',
        sha256
    };
    await conn.send(message);
}

export async function receiveStart(
    conn: DataConnection,
    expected: { transferId: string, size: number },
    prepare: () => Promise<void>
): Promise<StartMessage> {
    if (!Number.isSafeInteger(expected.size) || expected.size <= 0) {
        throw new Error('Expected size must be above 0');
    }

    const start = await waitOnConnection<Partial<StartMessage>>(
        conn, 
        'data', 
        'Timed out waiting for start message', 
        (data) => // this ensures the message is actually a start message
            data !== null &&
            typeof data === 'object' &&
            'type' in data &&
            data.type === 'start'
    );

    if (
        start.transferId !== expected.transferId ||
        start.size !== expected.size ||
        start.chunkSize !== CHUNK_SIZE ||
        start.sendWindow !== SEND_WINDOW
    ) {
        throw new Error('The start message is not the same as the expected transfer!')
    }

    const parsedTrack = transferredTrackSchema.safeParse(start.track);
    if (!parsedTrack.success) {
        throw new Error('The track metadata is invalid');
    }

    // The album and its cover are optional extras: if they don't check out, the track is still
    // taken, filed under the album its own metadata names.
    const parsedAlbum = start.album === undefined ? undefined : albumSchema.safeParse(start.album);
    const artwork = parsedAlbum?.success ? parseArtwork(start.artwork) : undefined;
    // The same goes for the playlist: without it the track is still added, just not to a playlist.
    const parsedPlaylist =
        start.playlist === undefined ? undefined : playlistSchema.safeParse(start.playlist);
    const playlistArtwork = parsedPlaylist?.success
        ? parseArtwork(start.playlistArtwork)
        : undefined;

    await prepare();

    if (!conn.open) {
        throw new Error('Connection closed before preparing');
    }

    return {
        type: 'start',
        transferId: expected.transferId,
        size: expected.size,
        chunkSize: CHUNK_SIZE,
        sendWindow: SEND_WINDOW,
        track: parsedTrack.data,
        ...(parsedAlbum?.success ? { album: parsedAlbum.data } : {}),
        ...(artwork ? { artwork } : {}),
        ...(parsedPlaylist?.success ? { playlist: parsedPlaylist.data } : {}),
        ...(playlistArtwork ? { playlistArtwork } : {})
    }
}

const ACK_EVERY_BYTES = 64 * 1024;

export async function receiveChunks(
    conn: DataConnection,
    start: StartMessage,
    write: (bytes: ArrayBuffer) => Promise<void>
): Promise<string> {
    const hash = await createSHA256();
    return new Promise((resolve, reject) => {
        let queueOffset = 0;
        let ackedOffset = 0;
        let writes = Promise.resolve();
        let settled = false;
        let awaitingEnd = false;
        let endTimer: ReturnType<typeof setTimeout> | undefined;

        function cleanup() {
            settled = true;
            clearTimeout(endTimer);
            conn.off('data', onData);
            conn.off('error', fail);
            conn.off('close', onClose);
        }

        function finish(sha256: string) {
            if (settled) return;
            cleanup();
            resolve(sha256);
        }

        function fail(error: unknown) {
            if (settled) return;
            cleanup();
            reject(error);
        }

        function onClose() {
            fail(new Error('Connection closed mid transfer'));
        }

        async function sendAck(nextOffset: number) {
            if (!conn.open) throw new Error('Connection closed mid transfer');
            ackedOffset = nextOffset;
            const ack: AckMessage = {
                type: 'ack',
                nextOffset
            };
            await conn.send(ack);
        }

        function onData(data: unknown) {
            if (settled) return;

            if (data !== null && typeof data === 'object' && 'type' in data && data.type === 'end') {
                if (
                    !awaitingEnd ||
                    !('sha256' in data) ||
                    typeof data.sha256 !== 'string' ||
                    !/^[a-f0-9]{64}$/i.test(data.sha256)
                ) {
                    fail(new Error('invalid end message'));
                    return;
                }

                const expected = data.sha256.toLowerCase();
                if (hash.digest('hex') !== expected) {
                    fail(new Error('Checksum mismatch'));
                    return;
                }
                finish(expected);
                return;
            }

            if ( // verify the message is actually a chunk...
                data === null ||
                typeof data !== 'object' ||
                !('type' in data) ||
                data.type !== 'chunk' ||
                !('offset' in data) ||
                data.offset !== queueOffset ||
                !('bytes' in data) ||
                !(data.bytes instanceof ArrayBuffer || ArrayBuffer.isView(data.bytes))
            ) {
                fail(new Error('Received invalid chunk message'));
                return;
            }

            const payload = data.bytes;
            const bytes = payload instanceof ArrayBuffer
                ? payload
                : new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength).slice().buffer;
            const expectedLength = Math.min(CHUNK_SIZE, start.size - queueOffset);
            const nextOffset = queueOffset + expectedLength;

            if ( expectedLength <= 0 || bytes.byteLength !== expectedLength || nextOffset - ackedOffset > start.sendWindow) {
                fail(new Error('Chunk is the wrong size'));
                return;
            }

            // update the queue offset
            queueOffset = nextOffset;

            // write each chunk in the proper order
            writes = writes.then(async () => {
                if (settled) return;
                hash.update(new Uint8Array(bytes));
                await write(bytes);
                if (settled) return;

                const isLastChunk = nextOffset === start.size;
                if (isLastChunk) {
                    awaitingEnd = true;
                    endTimer = setTimeout(() => {
                        fail(new Error('Timed out waiting for end message'));
                    }, CONNECT_TIMEOUT);
                }

                if (isLastChunk || nextOffset - ackedOffset >= ACK_EVERY_BYTES) {
                    await sendAck(nextOffset);
                }
            }).catch(fail);
        }

        conn.on('data', onData);
        conn.on('error', fail);
        conn.on('close', onClose);

        // send the first ack!!
        void sendAck(0).catch(fail);
    })
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
