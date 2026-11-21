import { dev } from '$app/environment';
import { env } from '$env/dynamic/public';

export const SERVER =
	env.PUBLIC_API_URL || (dev ? 'http://localhost:3000' : 'https://api.maple.music');

export const PEER_SERVER = env.PUBLIC_PEER_SERVER || (dev ? 'http://localhost:9000/peerjs' : 'https://api.maple.music:9000/peerjs');