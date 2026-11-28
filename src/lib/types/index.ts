import type { Socket } from 'socket.io-client';
import type {
	Listening,
	PlaybackReply,
	PlaybackStart,
	PlaybackStop,
	PlaybackUpdate,
	RpcUpdate
} from '$shared/types/playback';
import type { ListeningProfile, OwnProfile } from '$shared/types/profile';
import type { PeerClientEvents, PeerServerEvents } from '$shared/types/peer';

export type { FriendRequests, Profile } from '$shared/types/profile';
export type { Listening, ListeningVisibility } from '$shared/types/playback';

export type User = OwnProfile;
export type Friend = ListeningProfile;

type Reply = (result: PlaybackReply) => void;

export type MapleSocket = Socket<
	PeerServerEvents & {
		friendRequest: (data: { id: string }) => void;
		friendRemoved: (data: { id: string }) => void;
		listening: (data: { id: string; listening: Listening | null }) => void;
		playbackOwnership: (data: { playbackId: string | null }) => void;
		rpcUpdate: (data: RpcUpdate) => void;
		requestAccepted: (data: { id: string; message: string }) => void;
		acceptedRequest: (data: { id: string; message: string }) => void;
	},
	PeerClientEvents & {
		playbackStart: (data: PlaybackStart, reply: Reply) => void;
		playbackUpdate: (data: PlaybackUpdate, reply: Reply) => void;
		playbackStop: (data: PlaybackStop, reply: Reply) => void;
	}
>;

export type Album = {
	id: string;
	name: string;
	artist: string;
	image: string | Blob;
	year: number;
	genre?: string;
	tracks?: string[];
};

export type Artist = {
	id: string;
	name: string;
	image?: string | Blob;
	tracks?: string[];
	albums?: string[];
};

export enum DataType {
	FILE = 'FILE',
	OTHER = 'OTHER'
}

export interface PeerData {
	dataType: DataType;
	file?: Blob;
	fileName?: string;
	fileType?: string;
	message?: string;
}

export type Playlist = {
	id: string;
	name: string;
	description: string;
	tracks?: string[];
	image?: string | Blob;
	createdAt?: number;
	modifiedAt?: number;
};

export type LyricLine = { text: string; time?: number };

export type SongSource =
	| { kind: 'opfs' }
	| { kind: 'linked-folder'; folderId: string; path: string[] };

export type Song = {
	lyrics?: LyricLine[];
	id: string;
	title: string;
	artist: string;
	album: string;
	year: number;
	genre?: string;
	fileName: string;
	duration: number;
	image?: string | Blob;
	trackNumber: number;
	disk: number;
	ext: string;
	source?: SongSource;
};

export type AckMessage = {
	type: 'ack';
	nextOffset: number;
};

export type TransferredTrackMetadata = Omit<Song, 'image' | 'source'>;

/** The album a track was sent as part of ("Send to Device" on an album), minus its cover. */
export type TransferredAlbumMetadata = Pick<Album, 'name' | 'artist' | 'year' | 'genre'>;

/** An album's cover, sent with each of its tracks so the receiver's album gets the same one. */
export type TransferredArtwork = { bytes: ArrayBuffer; type: string };

/**
 * The largest album cover sent with a track. A bigger one is left out, and the receiver reads
 * the cover from the audio file instead.
 */
export const MAX_ARTWORK_BYTES = 5 * 1024 * 1024;

export type StartMessage = {
	type: 'start';
	transferId: string;
	size: number;
	chunkSize: number;
	sendWindow: number;
	track: TransferredTrackMetadata;
	album?: TransferredAlbumMetadata;
	artwork?: TransferredArtwork;
};

export type PeerMessage =
	| StartMessage
	| { type: 'chunk'; offset: number; bytes: ArrayBuffer }
	| AckMessage
	| { type: 'end'; sha256: string };
