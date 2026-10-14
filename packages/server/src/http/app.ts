import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { parseSessionId, type ApiError } from '@halcyon/core';
import { Hono, type Context } from 'hono';
import type { WorkspaceStore } from '../db/workspace-store.js';
import type { DiscoveryService } from '../discovery/discovery-service.js';

export interface AppOptions {
	discovery: DiscoveryService;
	workspaces: WorkspaceStore;
	/** Host header values accepted, e.g. `127.0.0.1:4317`. */
	allowedHosts: string[];
	/** Directory containing the built web UI, or null when it is not built. */
	webRoot: string | null;
}

export function createApp({ discovery, workspaces, allowedHosts, webRoot }: AppOptions): Hono {
	const app = new Hono();
	const hosts = new Set(allowedHosts.map((host) => host.toLowerCase()));
	const origins = new Set(allowedHosts.map((host) => `http://${host.toLowerCase()}`));

	// Binding to loopback is not enough: a hostile page can reach a local port
	// through DNS rebinding or a cross-site POST. Accept only our own Host, and
	// for writes, only our own Origin.
	app.use('*', async (c, next) => {
		const host = c.req.header('host')?.toLowerCase();
		if (!host || !hosts.has(host)) {
			return c.json<ApiError>({ error: 'Host not allowed' }, 403);
		}
		if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
			const origin = c.req.header('origin')?.toLowerCase();
			if (!origin || !origins.has(origin)) {
				return c.json<ApiError>({ error: 'Origin not allowed' }, 403);
			}
		}
		await next();
		c.header('X-Content-Type-Options', 'nosniff');
		c.header('Referrer-Policy', 'no-referrer');
		c.header('X-Frame-Options', 'DENY');
	});

	const api = new Hono();
	api.get('/health', (c) => c.json({ ok: true }));
	api.get('/sessions', async (c) => c.json(await discovery.current()));
	api.post('/sessions/refresh', async (c) => c.json(await discovery.refresh()));
	api.get('/workspace', (c) => {
		const workspace = workspaces.get();
		return workspace ? c.json(workspace) : c.json<ApiError>({ error: 'Workspace not found' }, 404);
	});
	api.put('/workspace/placements/:sessionId', async (c) => {
		const parsed = parseSessionId(c.req.param('sessionId'));
		if (!parsed) return c.json<ApiError>({ error: 'Invalid session ID' }, 400);
		const body = await readJson(c);
		if (!isFiniteNumber(body?.x) || !isFiniteNumber(body?.y)) {
			return c.json<ApiError>({ error: 'Expected finite numeric x and y' }, 400);
		}
		workspaces.setPlacement(parsed.id, { x: body.x, y: body.y });
		return c.body(null, 204);
	});
	api.put('/workspace/viewport', async (c) => {
		const body = await readJson(c);
		if (!isFiniteNumber(body?.x) || !isFiniteNumber(body?.y) || !isFiniteNumber(body?.zoom) || body.zoom <= 0) {
			return c.json<ApiError>({ error: 'Expected finite x, y and positive zoom' }, 400);
		}
		workspaces.setViewport({ x: body.x, y: body.y, zoom: body.zoom });
		return c.body(null, 204);
	});
	api.all('*', (c) => c.json<ApiError>({ error: 'Not found' }, 404));
	app.route('/api', api);

	if (webRoot) {
		app.use('*', serveStatic({ root: webRoot }));
		// SPA fallback: unknown non-API paths load the app shell.
		const shell = join(webRoot, '200.html');
		app.get('*', async (c) => c.html(await readFile(shell, 'utf8')));
	} else {
		app.get('*', (c) =>
			c.text('Halcyon UI is not built. Run `pnpm build` and restart, or use the web dev server.', 503)
		);
	}

	return app;
}

async function readJson(c: Context): Promise<Record<string, unknown> | null> {
	try {
		const value: unknown = await c.req.json();
		return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}
