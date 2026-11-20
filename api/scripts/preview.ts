import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import bcrypt from 'bcrypt';
import express from 'express';
import { ExpressPeerServer } from 'peer';
import { createMaple } from '../app.js';
import type { SendEmail } from '../auth/email.js';
import { password } from '../auth/password.js';
import { loadConfig } from '../config.js';
import { createFile } from '../storage/create-file.js';
import { openDatabase, type Database } from '../storage/sqlite.js';

const prefix = 'maple-preview-';
const defaultHost = '127.0.0.1';
const port = 3000;
const peerPort = 9000;
const peerPath = '/peerjs';
const guest = { username: 'guest', password: 'guest', email: 'guest@example.test' };
const legacy = { username: 'legacy', password: 'LegacyPreview1' };

const printEmail: SendEmail = async ({ to, subject, text }) => {
	console.log(`\n[PREVIEW] Email to ${to}: ${subject}\n${text}\n`);
};

function describe(error: Error) {
	return 'code' in error && error.code === 'EADDRINUSE' && 'port' in error
		? `Port ${error.port} is already in use. Free that port and try again.`
		: error.message;
}

async function assertPortFree(port: number, host: string) {
	for (const address of host === defaultHost ? [host, '::1'] : [host]) {
		await new Promise<void>((resolve, reject) => {
			const probe = net.createServer();
			probe.once('error', (error) => {
				if (
					address === '::1' &&
					'code' in error &&
					['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(String(error.code))
				)
					resolve();
				else reject(error);
			});
			probe.listen(port, address, () =>
				probe.close((error) => (error ? reject(error) : resolve()))
			);
		});
	}
}

function removeOwnedDirectory(directory: string) {
	const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
	if (!stats) return;
	const owned =
		stats.isDirectory() &&
		!stats.isSymbolicLink() &&
		path.basename(directory).startsWith(prefix) &&
		path.dirname(fs.realpathSync(directory)) === fs.realpathSync(os.tmpdir());
	if (!owned) throw new Error(`Refusing to remove unexpected path: ${directory}`);
	fs.rmSync(directory, { recursive: true, force: true });
}

async function main() {
	const args = process.argv.slice(2);
	const { values } = parseArgs({
		args: args.map((arg, i) => {
			const next = args[i + 1];
			return arg === '--host' && (next === undefined || next.startsWith('--'))
				? '--host=0.0.0.0'
				: arg;
		}),
		options: { host: { type: 'string', default: defaultHost } }
	});
	const host = values.host;
	if (!host) throw new Error('--host requires a non-empty address.');
	const urlHost = [defaultHost, '0.0.0.0', '::', '::1'].includes(host)
		? 'localhost'
		: net.isIPv6(host)
			? `[${host}]`
			: host;
	await Promise.all([assertPortFree(port, host), assertPortFree(peerPort, host)]);
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	let db: Database | undefined;
	const cleanup = () => {
		db?.close();
		db = undefined;
		removeOwnedDirectory(directory);
	};
	try {
		const databasePath = path.join(directory, 'maple.sqlite');
		await createFile(databasePath, (database) => {
			database
				.prepare('INSERT INTO users (id, username, password) VALUES (?, ?, ?)')
				.run(randomUUID(), legacy.username, bcrypt.hashSync(legacy.password, 10));
		});
		const config = loadConfig(
			{
				BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
				SQLITE_PATH: databasePath,
				PORT: String(port),
				API_URL: process.env.API_URL || `http://${urlHost}:${port}`,
				FRONTEND_URL: process.env.FRONTEND_URL || `http://${urlHost}:5173`
			},
			true
		);
		db = openDatabase(config.databasePath);
		const guestHash = await password.hash(guest.password);
		db.transaction((transaction) => {
			const id = randomUUID();
			const now = new Date().toISOString();
			transaction.run(
				'INSERT INTO auth_user (id, name, email, emailVerified, createdAt, updatedAt, username, displayUsername) VALUES (?, ?, ?, 1, ?, ?, ?, ?)',
				[id, guest.username, guest.email, now, now, guest.username, guest.username]
			);
			transaction.run(
				'INSERT INTO auth_account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
				[randomUUID(), id, 'credential', id, guestHash, now, now]
			);
		});
		const { server, io } = createMaple(config, db, printEmail);
		const peerApp = express();
		const peerServer = http.createServer(peerApp);
		const peer = ExpressPeerServer(peerServer, { path: peerPath });
		peer.on('error', (error) => console.error(`[PREVIEW] PeerJS error: ${error.message}`));
		peerApp.use(peer);

		let stopping = false;
		const stop = (code: number) => {
			if (stopping) return;
			stopping = true;
			peerServer.close();
			peerServer.closeAllConnections();
			io.close(() => {
				cleanup();
				console.log('[PREVIEW] Stopped and deleted the preview database.');
				// PeerJS keeps internal timers running after its HTTP server closes.
				process.exit(code);
			});
			server.closeAllConnections();
		};
		for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
			process.once(signal, () => stop(0));
		}
		const handleServerError = (error: Error) => {
			console.error(`[PREVIEW] Server error: ${describe(error)}`);
			stop(1);
		};
		server.once('error', handleServerError);
		peerServer.once('error', handleServerError);
		peerServer.listen(peerPort, host, () => {
			server.listen(port, host, () => {
				console.log(`[PREVIEW] Listening on ${host}, ports ${port} and ${peerPort}`);
				console.log(`[PREVIEW] Disposable API running at ${config.apiURL} for ${config.frontendURL}`);
				console.log(`[PREVIEW] PeerJS running at http://${urlHost}:${peerPort}${peerPath}`);
				console.log(`[PREVIEW] Temporary database: ${databasePath}`);
				console.log(`[PREVIEW] Test account: ${guest.username} / ${guest.password}`);
				console.log(`[PREVIEW] Legacy account: ${legacy.username} / ${legacy.password}`);
				console.log('[PREVIEW] Emails are printed here, not sent. Press Ctrl+C to stop.');
			});
		});
	} catch (error) {
		cleanup();
		throw error;
	}
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? describe(error) : String(error);
	console.error(`[PREVIEW] Startup failed: ${message}`);
	process.exitCode = 1;
});
