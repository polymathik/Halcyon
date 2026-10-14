import { describe, expect, it } from 'vitest';
import { normalizeTag } from '@halcyon/core';
import { createFixtureAdapter, fixtureSession } from '../src/adapters/fixture-adapter.js';
import { SessionCacheStore } from '../src/db/session-cache.js';
import { WorkspaceStore } from '../src/db/workspace-store.js';
import { DiscoveryService } from '../src/discovery/discovery-service.js';
import { createApp } from '../src/http/app.js';
import { ids, memoryDb } from './helpers.js';

const HOST = '127.0.0.1:4317';
const ORIGIN = `http://${HOST}`;

function setup() {
	const db = memoryDb();
	const workspaces = new WorkspaceStore(db);
	const app = createApp({
		discovery: new DiscoveryService([createFixtureAdapter('claude', [fixtureSession('claude', ids.a)])], new SessionCacheStore(db)),
		workspaces,
		allowedHosts: [HOST],
		webRoot: null
	});
	const call = (method: string, path: string, body?: unknown) =>
		app.request(path, {
			method,
			headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
			...(body === undefined ? {} : { body: JSON.stringify(body) })
		});
	return { call, workspaces, db };
}

const zone = { name: 'Building', color: 'sage', x: 0, y: 0, width: 400, height: 300 };

describe('tags', () => {
	it('normalizes tag names', () => {
		expect(normalizeTag('  #Auth Flow ')).toBe('auth-flow');
		expect(normalizeTag('#')).toBeNull();
		expect(normalizeTag('a'.repeat(41))).toBeNull();
		expect(normalizeTag('bad<tag>')).toBeNull();
	});

	it('replaces a session’s tags and removes tags nobody uses', async () => {
		const { call, workspaces } = setup();
		const sid = `claude:${ids.a}`;
		let res = await call('PUT', `/api/sessions/${sid}/tags`, { tags: ['#UI', 'perf', 'ui'] });
		expect(res.status).toBe(200);
		let body = await res.json();
		expect(body.tags.map((t: { name: string }) => t.name)).toEqual(['perf', 'ui']);
		expect(body.sessionTags).toHaveLength(2);
		res = await call('PUT', `/api/sessions/claude:${ids.b}/tags`, { tags: ['ui'] });
		res = await call('PUT', `/api/sessions/${sid}/tags`, { tags: [] });
		body = await res.json();
		expect(body.tags.map((t: { name: string }) => t.name)).toEqual(['ui']);
		expect(workspaces.get()?.sessionTags).toHaveLength(1);
	});

	it('rejects invalid tag payloads', async () => {
		const { call } = setup();
		expect((await call('PUT', `/api/sessions/claude:${ids.a}/tags`, { tags: ['ok', '<x>'] })).status).toBe(400);
		expect((await call('PUT', `/api/sessions/claude:${ids.a}/tags`, { tags: 'ui' })).status).toBe(400);
		expect((await call('PUT', `/api/sessions/claude:${ids.a}/tags`, { tags: Array(21).fill('x') })).status).toBe(400);
	});
});

describe('zones', () => {
	it('creates, updates and deletes a zone; deleting releases its cards', async () => {
		const { call, workspaces } = setup();
		const created = await (await call('POST', '/api/workspace/zones', zone)).json();
		expect(created).toMatchObject({ ...zone, id: expect.any(Number) });
		await call('PUT', '/api/workspace/placements', { placements: [{ sessionId: `claude:${ids.a}`, x: 16, y: 40, zoneId: created.id }] });
		expect(workspaces.get()?.placements[0]?.zoneId).toBe(created.id);

		const renamed = await (await call('PATCH', `/api/workspace/zones/${created.id}`, { name: 'Shipping', x: 10 })).json();
		expect(renamed).toMatchObject({ name: 'Shipping', x: 10, color: 'sage' });

		// Moving a card without zoneId keeps its zone; null removes it.
		await call('PUT', '/api/workspace/placements', { placements: [{ sessionId: `claude:${ids.a}`, x: 20, y: 44 }] });
		expect(workspaces.get()?.placements[0]?.zoneId).toBe(created.id);

		expect((await call('DELETE', `/api/workspace/zones/${created.id}`)).status).toBe(204);
		const after = workspaces.get()!;
		expect(after.zones).toEqual([]);
		expect(after.placements[0]).toMatchObject({ x: 20, y: 44, zoneId: null });
	});

	it('validates zone fields and unknown zones', async () => {
		const { call, workspaces } = setup();
		expect((await call('POST', '/api/workspace/zones', { ...zone, color: '#ff0000' })).status).toBe(400);
		expect((await call('POST', '/api/workspace/zones', { ...zone, name: ' ' })).status).toBe(400);
		expect((await call('POST', '/api/workspace/zones', { ...zone, width: 1 })).status).toBe(400);
		expect((await call('PATCH', '/api/workspace/zones/999', { name: 'x' })).status).toBe(404);
		expect((await call('DELETE', '/api/workspace/zones/999')).status).toBe(404);
		const bad = await call('PUT', '/api/workspace/placements', {
			placements: [{ sessionId: `claude:${ids.a}`, x: 1, y: 1 }, { sessionId: `claude:${ids.b}`, x: 1, y: 1, zoneId: 999 }]
		});
		expect(bad.status).toBe(404);
		expect(workspaces.get()?.placements).toEqual([]); // the whole batch rolled back
	});
});

describe('saved filter', () => {
	it('saves, normalizes and clears the filter', async () => {
		const { call, workspaces } = setup();
		expect((await call('PUT', '/api/workspace/filter', { tags: ['#UI', 'ui', 'perf'], mode: 'only' })).status).toBe(204);
		expect(workspaces.get()?.filter).toEqual({ tags: ['ui', 'perf'], mode: 'only' });
		expect((await call('PUT', '/api/workspace/filter', { tags: ['x'], mode: 'blur' })).status).toBe(400);
		expect((await call('PUT', '/api/workspace/filter', null)).status).toBe(204);
		expect(workspaces.get()?.filter).toBeNull();
	});
});
