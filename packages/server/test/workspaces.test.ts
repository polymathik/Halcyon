import { describe, expect, it } from 'vitest';
import type { WorkspaceExport, WorkspaceResponse, WorkspaceSummary } from '@halcyon/core';
import { createFixtureAdapter, fixtureSession } from '../src/adapters/fixture-adapter.js';
import { SessionCacheStore } from '../src/db/session-cache.js';
import { WorkspaceStore } from '../src/db/workspace-store.js';
import { DiscoveryService } from '../src/discovery/discovery-service.js';
import { createApp } from '../src/http/app.js';
import { ids, memoryDb } from './helpers.js';

const HOST = '127.0.0.1:4317';
const ORIGIN = `http://${HOST}`;
const A = `claude:${ids.a}` as const;
const B = `claude:${ids.b}` as const;

function setup() {
	const db = memoryDb();
	const workspaces = new WorkspaceStore(db);
	const app = createApp({
		discovery: new DiscoveryService([createFixtureAdapter('claude', [fixtureSession('claude', ids.a)])], new SessionCacheStore(db)),
		workspaces,
		allowedHosts: [HOST],
		webRoot: null
	});
	const call = async (method: string, path: string, body?: unknown) => {
		const res = await app.request(path, {
			method,
			headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
			...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) })
		});
		const text = await res.text();
		return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
	};
	return { call, workspaces };
}

const zone = { name: 'Building', color: 'sage', x: 0, y: 0, width: 400, height: 300 };

describe('named workspaces', () => {
	it('lists the default first and creates, renames and deletes others', async () => {
		const { call } = setup();
		const created = await call('POST', '/api/workspaces', { name: 'By tag' });
		expect(created.status).toBe(201);
		expect(created.json).toMatchObject({ name: 'By tag', cardCount: 0, zoneCount: 0, isDefault: false });

		const again = await call('POST', '/api/workspaces', { name: 'by TAG' });
		expect(again.json.name).toBe('by TAG (2)');

		const list = (await call('GET', '/api/workspaces')).json as WorkspaceSummary[];
		expect(list.map((w) => w.name)).toEqual(['Default', 'By tag', 'by TAG (2)']);
		expect(list[0]!.isDefault).toBe(true);

		expect((await call('PATCH', `/api/workspaces/${created.json.id}`, { name: 'Review' })).json.name).toBe('Review');
		expect((await call('PATCH', `/api/workspaces/${created.json.id}`, { name: '' })).status).toBe(400);
		expect((await call('DELETE', '/api/workspaces/default')).status).toBe(409);
		expect((await call('DELETE', `/api/workspaces/${created.json.id}`)).status).toBe(204);
		expect((await call('DELETE', `/api/workspaces/${created.json.id}`)).status).toBe(404);
		expect((await call('GET', '/api/workspaces')).json).toHaveLength(2);
	});

	it('scopes layout routes by ?workspace= and keeps tags, names and archive shared', async () => {
		const { call } = setup();
		const other = (await call('POST', '/api/workspaces', { name: 'Other' })).json.id as string;
		const z = (await call('POST', `/api/workspace/zones?workspace=${other}`, zone)).json;
		await call('PUT', `/api/workspace/placements?workspace=${other}`, { placements: [{ sessionId: A, x: 10, y: 20, zoneId: z.id }] });
		await call('PUT', `/api/sessions/${A}/tags`, { tags: ['auth'] });

		const def = (await call('GET', '/api/workspace')).json as WorkspaceResponse;
		expect(def.zones).toEqual([]);
		expect(def.placements).toEqual([]);
		expect(def.sessionTags).toHaveLength(1);

		const ws = (await call('GET', `/api/workspace?workspace=${other}`)).json as WorkspaceResponse;
		expect(ws.zones.map((zz) => zz.name)).toEqual(['Building']);
		expect(ws.placements).toEqual([{ sessionId: A, x: 10, y: 20, zoneId: z.id }]);

		// A zone from one workspace can't be used or edited from another.
		expect((await call('PATCH', `/api/workspace/zones/${z.id}`, { name: 'x' })).status).toBe(404);
		expect((await call('GET', '/api/workspace?workspace=nope')).status).toBe(404);
		expect((await call('PUT', '/api/workspace/viewport?workspace=nope', { x: 0, y: 0, zoom: 1 })).status).toBe(404);
	});

	it('duplicates a layout with zones remapped to the copy', async () => {
		const { call } = setup();
		const z = (await call('POST', '/api/workspace/zones', { ...zone, collapsed: true, projectPath: '/w/app' })).json;
		await call('PUT', '/api/workspace/placements', { placements: [{ sessionId: A, x: 1, y: 2, zoneId: z.id }, { sessionId: B, x: 3, y: 4 }] });
		await call('PUT', '/api/workspace/viewport', { x: 5, y: 6, zoom: 0.5 });

		const copy = (await call('POST', '/api/workspaces', { name: 'Copy', copyFrom: 'default' })).json as WorkspaceSummary;
		expect(copy).toMatchObject({ cardCount: 2, zoneCount: 1 });
		const ws = (await call('GET', `/api/workspace?workspace=${copy.id}`)).json as WorkspaceResponse;
		expect(ws.zones[0]).toMatchObject({ name: 'Building', collapsed: true, projectPath: '/w/app' });
		expect(ws.zones[0]!.id).not.toBe(z.id);
		expect(ws.placements.find((p) => p.sessionId === A)!.zoneId).toBe(ws.zones[0]!.id);
		expect(ws.viewport).toEqual({ x: 5, y: 6, zoom: 0.5 });

		// Changing the copy leaves the original alone.
		await call('DELETE', `/api/workspace/zones/${ws.zones[0]!.id}?workspace=${copy.id}`);
		expect((await call('GET', '/api/workspace')).json.zones).toHaveLength(1);
		expect((await call('POST', '/api/workspaces', { name: 'X', copyFrom: 'missing' })).status).toBe(404);
	});
});

describe('export and import', () => {
	it('round-trips a workspace and merges shared state without overwriting', async () => {
		const { call } = setup();
		const z = (await call('POST', '/api/workspace/zones', zone)).json;
		await call('PUT', '/api/workspace/placements', { placements: [{ sessionId: A, x: 1, y: 2, zoneId: z.id }] });
		await call('PUT', '/api/workspace/filter', { tags: ['auth'], mode: 'only' });
		await call('PUT', `/api/sessions/${A}/tags`, { tags: ['auth'] });
		await call('PUT', `/api/sessions/${A}/title`, { title: 'Original name' });
		await call('PUT', '/api/sessions/archive', { sessionIds: [B], archived: true });

		const exported = await call('GET', '/api/workspaces/default/export');
		expect(exported.headers.get('content-disposition')).toContain('halcyon-default.json');
		const file = exported.json as WorkspaceExport;
		expect(file).toMatchObject({ format: 'halcyon-workspace', version: 1, name: 'Default' });
		expect(JSON.stringify(file)).not.toMatch(/transcript|message/i);

		// Local edits after the export: the import must not overwrite them.
		await call('PUT', `/api/sessions/${A}/title`, { title: 'Renamed since' });
		await call('PUT', `/api/sessions/${A}/tags`, { tags: ['later'] });
		await call('PUT', '/api/sessions/archive', { sessionIds: [B], archived: false });

		const imported = await call('POST', '/api/workspaces/import', file);
		expect(imported.status).toBe(201);
		expect(imported.json.workspace).toMatchObject({ name: 'Default (2)', cardCount: 1, zoneCount: 1 });
		expect(imported.json.skipped).toBe(0);

		const ws = (await call('GET', `/api/workspace?workspace=${imported.json.workspace.id}`)).json as WorkspaceResponse;
		expect(ws.placements[0]).toMatchObject({ sessionId: A, zoneId: ws.zones[0]!.id });
		expect(ws.filter).toEqual({ tags: ['auth'], mode: 'only' });
		expect(ws.titles).toEqual([{ sessionId: A, title: 'Renamed since' }]);
		const names = new Map(ws.tags.map((t) => [t.id, t.name]));
		expect(ws.sessionTags.filter((t) => t.sessionId === A).map((t) => names.get(t.tagId)).sort()).toEqual(['auth', 'later']);
		expect(ws.archived).toEqual([B]);
	});

	it('rejects files that are not exports and skips invalid entries', async () => {
		const { call } = setup();
		expect((await call('POST', '/api/workspaces/import', '{nope')).status).toBe(400);
		expect((await call('POST', '/api/workspaces/import', { format: 'other', version: 1, name: 'x' })).status).toBe(400);
		expect((await call('POST', '/api/workspaces/import', { format: 'halcyon-workspace', version: 2, name: 'x' })).status).toBe(400);

		const res = await call('POST', '/api/workspaces/import', {
			format: 'halcyon-workspace',
			version: 1,
			name: 'Hand edited',
			zones: [
				{ ref: 1, ...zone },
				{ ref: 2, ...zone, color: 'neon' },
				{ ref: 1, ...zone }
			],
			placements: [
				{ sessionId: A, x: 0, y: 0, zone: 1 },
				{ sessionId: '../../etc', x: 0, y: 0 },
				{ sessionId: B, x: 1e12, y: 0 },
				{ sessionId: A, x: 9, y: 9 }
			],
			tags: [{ sessionId: A, tags: ['ok', 'bad tag!'] }],
			titles: [{ sessionId: A, title: 'x'.repeat(500) }],
			archived: ['nope'],
			extra: { ignored: true }
		});
		expect(res.status).toBe(201);
		expect(res.json.skipped).toBe(8);
		expect(res.json.workspace).toMatchObject({ cardCount: 1, zoneCount: 1 });

		const big = JSON.stringify({ format: 'halcyon-workspace', version: 1, name: 'Big', pad: 'x'.repeat(5 * 1024 * 1024) });
		expect((await call('POST', '/api/workspaces/import', big)).status).toBe(413);
	});

	it('refuses workspace changes from another origin', async () => {
		const { workspaces } = setup();
		const app = createApp({
			discovery: new DiscoveryService([], new SessionCacheStore(memoryDb())),
			workspaces,
			allowedHosts: [HOST],
			webRoot: null
		});
		const res = await app.request('/api/workspaces/import', {
			method: 'POST',
			headers: { host: HOST, origin: 'http://evil.example', 'content-type': 'application/json' },
			body: JSON.stringify({ format: 'halcyon-workspace', version: 1, name: 'x' })
		});
		expect(res.status).toBe(403);
		expect(workspaces.list()).toHaveLength(1);
	});
});
