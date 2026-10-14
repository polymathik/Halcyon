import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import {
	MAX_ARCHIVE_BATCH,
	MAX_TAGS_PER_SESSION,
	MAX_TITLE_LENGTH,
	normalizeTag,
	parseSessionId,
	ZONE_COLORS,
	type ApiError,
	type LiveResponse,
	type SavedFilter,
	type SessionId,
	type SessionCommandResponse,
	type SessionPreviewResponse,
	type ZoneColor,
	type ZoneInput
} from '@halcyon/core';
import { Hono, type Context } from 'hono';
import { displayCommand, NativeActions } from '../actions/native.js';
import { NotFoundError, type PlacementInput, type WorkspaceStore } from '../db/workspace-store.js';
import { PREVIEW_LIMIT, type DiscoveryService } from '../discovery/discovery-service.js';
import { contentSecurityPolicy } from './csp.js';
import type { LiveService } from '../live/live-service.js';

/** Older snapshots are served immediately while a background rescan runs. */
const SNAPSHOT_MAX_AGE_MS = 10_000;
const MAX_BATCH_PLACEMENTS = 2_000;
const MAX_ZONE_NAME = 80;
/** Coordinates beyond this are almost certainly a client bug. */
const MAX_COORDINATE = 10_000_000;

export interface AppOptions {
	discovery: DiscoveryService;
	workspaces: WorkspaceStore;
	/** Host header values accepted, e.g. `127.0.0.1:4317`. */
	allowedHosts: string[];
	/** Directory containing the built web UI, or null when it is not built. */
	webRoot: string | null;
	/** Native actions; tests inject a fake launcher. */
	actions?: NativeActions;
	/** Live session state; omitted means every provider reports none. */
	live?: LiveService;
}

export function createApp({ discovery, workspaces, allowedHosts, webRoot, actions = new NativeActions(), live }: AppOptions): Hono {
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
	api.onError((error, c) => {
		if (error instanceof NotFoundError) return c.json<ApiError>({ error: error.message }, 404);
		// Never echo internals; messages may reference local paths.
		return c.json<ApiError>({ error: 'Internal error' }, 500);
	});

	api.get('/health', (c) => c.json({ ok: true }));

	// ---------- sessions ----------
	api.get('/sessions', async (c) => c.json(await discovery.current(SNAPSHOT_MAX_AGE_MS)));
	api.post('/sessions/refresh', async (c) => c.json(await discovery.refresh()));
	api.get('/live', async (c) => {
		c.header('Cache-Control', 'no-store');
		if (!live) return c.json<LiveResponse>({ checkedAt: new Date().toISOString(), providers: [], sessions: [] });
		return c.json(await live.current());
	});

	api.get('/sessions/:sessionId/preview', async (c) => {
		// Transcript text: never cache in the browser, never log.
		c.header('Cache-Control', 'no-store');
		const parsed = parseSessionId(c.req.param('sessionId'));
		if (!parsed) return c.json<ApiError>({ error: 'Invalid session ID' }, 400);
		const result = await discovery.preview(parsed.id);
		switch (result.kind) {
			case 'ok':
				return c.json<SessionPreviewResponse>({ sessionId: parsed.id, messages: result.messages, limit: PREVIEW_LIMIT });
			case 'not-found':
				return c.json<ApiError>({ error: 'Session not found' }, 404);
			case 'unsupported':
				return c.json<ApiError>({ error: 'Preview is not available for this provider' }, 501);
			case 'error':
				return c.json<ApiError>({ error: result.message }, 500);
		}
	});

	api.get('/sessions/:sessionId/command', async (c) => {
		const parsed = parseSessionId(c.req.param('sessionId'));
		if (!parsed) return c.json<ApiError>({ error: 'Invalid session ID' }, 400);
		const found = await discovery.session(parsed.id);
		if (!found) return c.json<ApiError>({ error: 'Session not found' }, 404);
		return c.json<SessionCommandResponse>({
			sessionId: parsed.id,
			command: found.command ? displayCommand(found.command) : null,
			canResume: !!found.command && actions.canResume,
			canOpenFolder: !!found.session.projectPath
		});
	});

	api.post('/sessions/:sessionId/resume', async (c) => {
		const parsed = parseSessionId(c.req.param('sessionId'));
		if (!parsed) return c.json<ApiError>({ error: 'Invalid session ID' }, 400);
		const found = await discovery.session(parsed.id);
		if (!found) return c.json<ApiError>({ error: 'Session not found' }, 404);
		if (!found.command) return c.json<ApiError>({ error: 'This provider has no resume command' }, 409);
		const result = await actions.resume(found.command);
		return result.ok ? c.body(null, 204) : c.json<ApiError>({ error: result.reason }, 409);
	});

	api.post('/sessions/:sessionId/open-folder', async (c) => {
		const parsed = parseSessionId(c.req.param('sessionId'));
		if (!parsed) return c.json<ApiError>({ error: 'Invalid session ID' }, 400);
		const found = await discovery.session(parsed.id);
		if (!found) return c.json<ApiError>({ error: 'Session not found' }, 404);
		const result = await actions.openFolder(found.session.latestPath ?? found.session.projectPath);
		return result.ok ? c.body(null, 204) : c.json<ApiError>({ error: result.reason }, 409);
	});

	api.put('/sessions/:sessionId/tags', async (c) => {
		const parsed = parseSessionId(c.req.param('sessionId'));
		if (!parsed) return c.json<ApiError>({ error: 'Invalid session ID' }, 400);
		const body = await readJson(c);
		const raw = body?.tags;
		if (!Array.isArray(raw) || raw.length > MAX_TAGS_PER_SESSION || !raw.every((t) => typeof t === 'string')) {
			return c.json<ApiError>({ error: `Expected tags: an array of at most ${MAX_TAGS_PER_SESSION} strings` }, 400);
		}
		const names: string[] = [];
		for (const value of raw as string[]) {
			const tag = normalizeTag(value);
			if (!tag) return c.json<ApiError>({ error: 'Tags use letters, numbers, - _ . / + and at most 40 characters' }, 400);
			names.push(tag);
		}
		return c.json(workspaces.setSessionTags(parsed.id, names));
	});

	api.put('/sessions/archive', async (c) => {
		const body = await readJson(c);
		const raw = body?.sessionIds;
		if (!Array.isArray(raw) || raw.length > MAX_ARCHIVE_BATCH || typeof body?.archived !== 'boolean') {
			return c.json<ApiError>({ error: `Expected { sessionIds: string[] (at most ${MAX_ARCHIVE_BATCH}), archived: boolean }` }, 400);
		}
		const ids: SessionId[] = [];
		for (const value of raw) {
			const parsed = parseSessionId(value);
			if (!parsed) return c.json<ApiError>({ error: 'Invalid session ID' }, 400);
			ids.push(parsed.id);
		}
		workspaces.setArchived(ids, body.archived);
		return c.body(null, 204);
	});

	api.put('/sessions/:sessionId/title', async (c) => {
		const parsed = parseSessionId(c.req.param('sessionId'));
		if (!parsed) return c.json<ApiError>({ error: 'Invalid session ID' }, 400);
		const body = await readJson(c);
		const raw = body?.title;
		if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
			workspaces.setSessionTitle(parsed.id, null);
			return c.body(null, 204);
		}
		if (typeof raw !== 'string' || raw.trim().length > MAX_TITLE_LENGTH || /[\u0000-\u001f]/.test(raw)) {
			return c.json<ApiError>({ error: `Expected a title of at most ${MAX_TITLE_LENGTH} characters, or null` }, 400);
		}
		workspaces.setSessionTitle(parsed.id, raw.trim());
		return c.body(null, 204);
	});

	// ---------- workspace ----------
	api.get('/workspace', (c) => {
		const workspace = workspaces.get();
		return workspace ? c.json(workspace) : c.json<ApiError>({ error: 'Workspace not found' }, 404);
	});

	api.put('/workspace/placements/:sessionId', async (c) => {
		const parsed = parseSessionId(c.req.param('sessionId'));
		if (!parsed) return c.json<ApiError>({ error: 'Invalid session ID' }, 400);
		const body = await readJson(c);
		if (!isCoordinate(body?.x) || !isCoordinate(body?.y)) {
			return c.json<ApiError>({ error: 'Expected finite numeric x and y' }, 400);
		}
		workspaces.setPlacement(parsed.id, { x: body.x, y: body.y });
		return c.body(null, 204);
	});

	api.put('/workspace/placements', async (c) => {
		const body = await readJson(c);
		const list = body?.placements;
		if (!Array.isArray(list) || list.length > MAX_BATCH_PLACEMENTS) {
			return c.json<ApiError>({ error: `Expected a placements array of at most ${MAX_BATCH_PLACEMENTS}` }, 400);
		}
		const placements: PlacementInput[] = [];
		for (const item of list as unknown[]) {
			const entry = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
			const parsed = typeof entry?.sessionId === 'string' ? parseSessionId(entry.sessionId) : null;
			const zoneId = entry?.zoneId;
			const zoneOk = zoneId === undefined || zoneId === null || (Number.isInteger(zoneId) && (zoneId as number) > 0);
			if (!parsed || !isCoordinate(entry?.x) || !isCoordinate(entry?.y) || !zoneOk) {
				return c.json<ApiError>({ error: 'Each placement needs a valid sessionId, finite x and y, and an optional zoneId' }, 400);
			}
			placements.push({
				sessionId: parsed.id,
				x: entry.x,
				y: entry.y,
				...(zoneId === undefined ? {} : { zoneId: zoneId as number | null })
			});
		}
		workspaces.setPlacements(placements);
		return c.body(null, 204);
	});

	api.put('/workspace/viewport', async (c) => {
		const body = await readJson(c);
		if (!isCoordinate(body?.x) || !isCoordinate(body?.y) || !isFiniteNumber(body?.zoom) || body.zoom <= 0) {
			return c.json<ApiError>({ error: 'Expected finite x, y and positive zoom' }, 400);
		}
		workspaces.setViewport({ x: body.x, y: body.y, zoom: body.zoom });
		return c.body(null, 204);
	});

	api.put('/workspace/filter', async (c) => {
		const body = await readJson(c);
		const filter = parseFilter(body);
		if (filter === undefined) return c.json<ApiError>({ error: 'Expected { tags: string[], mode: "highlight" | "only" } or null' }, 400);
		workspaces.setFilter(filter);
		return c.body(null, 204);
	});

	api.post('/workspace/zones', async (c) => {
		const input = parseZone(await readJson(c), false);
		if (!input) return c.json<ApiError>({ error: 'Expected name, color, x, y, width and height' }, 400);
		return c.json(workspaces.createZone(input as ZoneInput), 201);
	});

	api.patch('/workspace/zones/:zoneId', async (c) => {
		const id = Number(c.req.param('zoneId'));
		if (!Number.isInteger(id) || id <= 0) return c.json<ApiError>({ error: 'Invalid zone ID' }, 400);
		const changes = parseZone(await readJson(c), true);
		if (!changes) return c.json<ApiError>({ error: 'Invalid zone fields' }, 400);
		return c.json(workspaces.updateZone(id, changes));
	});

	api.delete('/workspace/zones/:zoneId', (c) => {
		const id = Number(c.req.param('zoneId'));
		if (!Number.isInteger(id) || id <= 0) return c.json<ApiError>({ error: 'Invalid zone ID' }, 400);
		workspaces.deleteZone(id);
		return c.body(null, 204);
	});

	api.all('*', (c) => c.json<ApiError>({ error: 'Not found' }, 404));
	app.route('/api', api);

	if (webRoot) {
		const shell = join(webRoot, '200.html');
		// Cached, but re-read when the build changes so a rebuild never serves stale asset names.
		let cached: { mtimeMs: number; html: string; csp: string } | null = null;
		const loadShell = async () => {
			const { mtimeMs } = await stat(shell);
			if (!cached || cached.mtimeMs !== mtimeMs) {
				const html = await readFile(shell, 'utf8');
				cached = { mtimeMs, html, csp: contentSecurityPolicy(html) };
			}
			return cached;
		};
		app.use('*', async (c, next) => {
			await next();
			c.header('Content-Security-Policy', (await loadShell()).csp);
		});
		app.use('*', serveStatic({ root: webRoot }));
		// SPA fallback: unknown non-API paths load the app shell.
		app.get('*', async (c) => c.html((await loadShell()).html));
	} else {
		app.get('*', (c) =>
			c.text('Halcyon UI is not built. Run `pnpm build` and restart, or use the web dev server.', 503)
		);
	}

	return app;
}

function parseZone(body: Record<string, unknown> | null, partial: boolean): Partial<ZoneInput> | null {
	if (!body) return null;
	const out: Partial<ZoneInput> = {};
	const has = (key: string) => body[key] !== undefined;
	if (has('name') || !partial) {
		const name = typeof body.name === 'string' ? body.name.trim() : '';
		if (!name || name.length > MAX_ZONE_NAME) return null;
		out.name = name;
	}
	if (has('color') || !partial) {
		if (!(ZONE_COLORS as readonly unknown[]).includes(body.color)) return null;
		out.color = body.color as ZoneColor;
	}
	for (const key of ['x', 'y'] as const) {
		if (has(key) || !partial) {
			if (!isCoordinate(body[key])) return null;
			out[key] = body[key];
		}
	}
	if (has('collapsed')) {
		if (typeof body.collapsed !== 'boolean') return null;
		out.collapsed = body.collapsed;
	}
	if (has('projectPath')) {
		const value = body.projectPath;
		if (value !== null && (typeof value !== 'string' || value.length === 0 || value.length > 4096)) return null;
		out.projectPath = value as string | null;
	}
	for (const key of ['width', 'height'] as const) {
		if (has(key) || !partial) {
			const value = body[key];
			if (!isFiniteNumber(value) || value < 40 || value > MAX_COORDINATE) return null;
			out[key] = value;
		}
	}
	return Object.keys(out).length ? out : null;
}

/** `undefined` means invalid; `null` clears the saved filter. */
function parseFilter(body: Record<string, unknown> | null): SavedFilter | null | undefined {
	if (body === null) return null;
	const { tags, mode } = body;
	if (!Array.isArray(tags) || tags.length > 50 || (mode !== 'highlight' && mode !== 'only')) return undefined;
	const names: string[] = [];
	for (const value of tags) {
		const tag = typeof value === 'string' ? normalizeTag(value) : null;
		if (!tag) return undefined;
		names.push(tag);
	}
	return { tags: [...new Set(names)], mode };
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

function isCoordinate(value: unknown): value is number {
	return isFiniteNumber(value) && Math.abs(value) <= MAX_COORDINATE;
}
