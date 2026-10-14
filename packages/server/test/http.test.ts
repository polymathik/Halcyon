import { describe, expect, it } from 'vitest';
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
	const adapters = [createFixtureAdapter('claude', [fixtureSession('claude', ids.a, { title: 'Fixture' })])];
	const app = createApp({
		discovery: new DiscoveryService(adapters, new SessionCacheStore(db)),
		workspaces: new WorkspaceStore(db),
		allowedHosts: [HOST, 'localhost:4317'],
		webRoot: null
	});
	const request = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
		app.request(path, { ...init, headers: { host: HOST, ...init.headers } });
	return { app, request };
}

describe('local API', () => {
	it('serves fixture sessions with provider health', async () => {
		const res = await setup().request('/api/sessions');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.sessions).toMatchObject([{ id: `claude:${ids.a}`, title: 'Fixture' }]);
		expect(body.providers).toMatchObject([{ provider: 'claude', health: { state: 'ok', sessionCount: 1 } }]);
	});

	it('rejects requests addressed to another host (DNS rebinding)', async () => {
		const res = await setup().request('/api/sessions', { headers: { host: 'attacker.example:4317' } });
		expect(res.status).toBe(403);
	});

	it('rejects writes without our own Origin', async () => {
		const { request } = setup();
		const put = (headers: Record<string, string>) =>
			request(`/api/workspace/placements/claude:${ids.a}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json', ...headers },
				body: JSON.stringify({ x: 1, y: 2 })
			});
		expect((await put({})).status).toBe(403);
		expect((await put({ origin: 'https://attacker.example' })).status).toBe(403);
		expect((await put({ origin: ORIGIN })).status).toBe(204);
	});

	it('persists a validated card placement', async () => {
		const { request } = setup();
		const put = (sessionId: string, body: unknown) =>
			request(`/api/workspace/placements/${sessionId}`, {
				method: 'PUT',
				headers: { origin: ORIGIN, 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});

		expect((await put('claude:not-a-uuid', { x: 1, y: 2 })).status).toBe(400);
		expect((await put(`claude:${ids.a}`, { x: 'left', y: 2 })).status).toBe(400);
		expect((await put(`claude:${ids.a}`, { x: 10, y: 20 })).status).toBe(204);

		const workspace = await (await request('/api/workspace')).json();
		expect(workspace.placements).toEqual([{ sessionId: `claude:${ids.a}`, x: 10, y: 20, zoneId: null }]);
	});

	it('returns JSON 404 for unknown API routes and 503 when the UI is not built', async () => {
		const { request } = setup();
		expect((await request('/api/nope')).status).toBe(404);
		expect((await request('/')).status).toBe(503);
	});
});
