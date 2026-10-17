import { existsSync, mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdaptorServer } from '@hono/node-server';
import type { ProcessProbe, ProviderAdapter } from '@halcyon/core';
import { migrate } from './db/migrations.js';
import { SessionCacheStore } from './db/session-cache.js';
import { openDatabase, type Database } from './db/sqlite.js';
import { WorkspaceStore } from './db/workspace-store.js';
import { DiscoveryService } from './discovery/discovery-service.js';
import type { GitReader } from './discovery/git-info.js';
import { createApp } from './http/app.js';
import type { NativeActions } from './actions/native.js';
import { LiveService } from './live/live-service.js';
import { createProcessProbe } from './live/process-probe.js';

export const LOOPBACK = '127.0.0.1';

export interface StartOptions {
	port: number;
	dataDir?: string;
	adapters: ProviderAdapter[];
	webRoot?: string | null;
	/** Process facts for live state; defaults to the real system probe. */
	probe?: ProcessProbe;
	/** Native actions; defaults to launching real terminals. */
	actions?: NativeActions;
	/** Git state of session folders; defaults to reading their `.git` files. */
	git?: GitReader;
}

export interface RunningServer {
	url: string;
	port: number;
	close(): Promise<void>;
}

export function defaultDataDir(): string {
	return process.env.HALCYON_HOME ?? join(homedir(), '.halcyon');
}

/** The packaged UI (dist/web), falling back to the monorepo build output. */
export function defaultWebRoot(): string | null {
	const candidates = [
		fileURLToPath(new URL('./web/', import.meta.url)),
		fileURLToPath(new URL('../../../apps/web/build/', import.meta.url))
	];
	return candidates.find((dir) => existsSync(join(dir, '200.html'))) ?? null;
}

export async function startServer(options: StartOptions): Promise<RunningServer> {
	// The port is only known after listen when 0 is requested, and the Host
	// allowlist depends on it, so resolve the app lazily per request.
	let app: ReturnType<typeof createApp> | null = null;
	const server = createAdaptorServer({
		hostname: LOOPBACK,
		fetch: (request, env) => app!.fetch(request, env)
	});

	const port = await new Promise<number>((resolve, reject) => {
		server.once('error', reject);
		server.listen(options.port, LOOPBACK, () => {
			server.off('error', reject);
			resolve((server.address() as AddressInfo).port);
		});
	});

	// Open storage only once the port is ours, so a busy-port retry leaks nothing.
	const dataDir = options.dataDir ?? defaultDataDir();
	let db: Database;
	try {
		mkdirSync(dataDir, { recursive: true, mode: 0o700 });
		db = openDatabase(join(dataDir, 'halcyon.db'));
		migrate(db);
	} catch (error) {
		server.close();
		throw error;
	}
	const discovery = new DiscoveryService(
		options.adapters,
		new SessionCacheStore(db),
		options.git ? { git: options.git } : {}
	);
	const webRoot = options.webRoot === undefined ? defaultWebRoot() : options.webRoot;

	app = createApp({
		discovery,
		workspaces: new WorkspaceStore(db),
		allowedHosts: [`${LOOPBACK}:${port}`, `localhost:${port}`],
		webRoot,
		...(options.actions ? { actions: options.actions } : {}),
		live: new LiveService({
			adapters: options.adapters,
			probe: options.probe ?? createProcessProbe(),
			sessionForSource: (path) => discovery.sessionForSource(path),
			knownSessions: () => discovery.knownIds(),
			rescan: () => void discovery.refresh()
		})
	});
	// Warm the index so the first page load is fast; failures surface per provider.
	void discovery.refresh();

	return {
		url: `http://${LOOPBACK}:${port}/`,
		port,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => {
					db.close();
					resolve();
				});
			})
	};
}
