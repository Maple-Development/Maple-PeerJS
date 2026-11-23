import { browser, dev } from '$app/environment';
import { env } from '$env/dynamic/public';

/**
 * In dev, the API and PeerServer run on the same machine as Vite, so reach them at whatever
 * host the page itself was opened on: 127.0.0.1 on this computer, its LAN or Tailscale address
 * on a phone. A fixed "localhost" would point a phone at itself.
 */
function devURL(port: number, path = '') {
	const { protocol, hostname } = browser ? location : { protocol: 'http:', hostname: '127.0.0.1' };
	const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
	return `${protocol}//${host}:${port}${path}`;
}

export const SERVER = env.PUBLIC_API_URL || (dev ? devURL(3000) : 'https://api.maple.music');

export const PEER_SERVER =
	env.PUBLIC_PEER_SERVER || (dev ? devURL(9000, '/peerjs') : 'https://api.maple.music:9000/peerjs');
