import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createFixtureAdapter, fixtureSession } from '../src/adapters/fixture-adapter.js';
import { migrate } from '../src/db/migrations.js';
import { SessionCacheStore } from '../src/db/session-cache.js';
import { WorkspaceStore } from '../src/db/workspace-store.js';
import { DiscoveryService } from '../src/discovery/discovery-service.js';
import { ProjectRootResolver } from '../src/discovery/project-root.js';
import { createApp } from '../src/http/app.js';
import { ids, memoryDb } from './helpers.js';

const base = mkdtempSync(join(tmpdir(), 'halcyon-roots-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const HOST = '127.0.0.1:4317';
function setup(projectPath: string | null = null) {
	const db = memoryDb();
	const workspaces = new WorkspaceStore(db);
	const discovery = new DiscoveryService(
		[createFixtureAdapter('claude', [fixtureSession('claude', ids.a, { projectPath })])],
		new SessionCacheStore(db)
	);
	const app = createApp({ discovery, workspaces, allowedHosts: [HOST], webRoot: null });
	const call = (method: string, path: string, body?: unknown) =>
		app.request(path, {
			method,
			headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/json' },
			...(body === undefined ? {} : { body: JSON.stringify(body) })
		});
	return { call, workspaces, discovery };
}

describe('schema v3', () => {
	it('migrates to the latest version', () => {
		const db = memoryDb();
		expect(migrate(db)).toBe(3);
		expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 });
	});
});

describe('session display names', () => {
	it('sets, trims, validates and clears a title', async () => {
		const { call, workspaces } = setup();
		const sid = `claude:${ids.a}`;
		expect((await call('PUT', `/api/sessions/${sid}/title`, { title: '  Auth rewrite  ' })).status).toBe(204);
		expect(workspaces.get()?.titles).toEqual([{ sessionId: sid, title: 'Auth rewrite' }]);
		expect((await call('PUT', `/api/sessions/${sid}/title`, { title: 'x'.repeat(121) })).status).toBe(400);
		expect((await call('PUT', `/api/sessions/${sid}/title`, { title: 'bad\nline' })).status).toBe(400);
		expect((await call('PUT', `/api/sessions/${sid}/title`, { title: 42 })).status).toBe(400);
		expect((await call('PUT', `/api/sessions/${sid}/title`, { title: '' })).status).toBe(204);
		expect(workspaces.get()?.titles).toEqual([]);
	});
});

describe('project zones', () => {
	it('stores the project a zone collects', async () => {
		const { call } = setup();
		const zone = await (
			await call('POST', '/api/workspace/zones', { name: 'api', color: 'sky', x: 0, y: 0, width: 300, height: 200, projectPath: '/work/api' })
		).json();
		expect(zone.projectPath).toBe('/work/api');
		const cleared = await (await call('PATCH', `/api/workspace/zones/${zone.id}`, { projectPath: null })).json();
		expect(cleared.projectPath).toBeNull();
		expect((await call('PATCH', `/api/workspace/zones/${zone.id}`, { projectPath: '' })).status).toBe(400);
		expect(zone.collapsed).toBe(false);
		const collapsed = await (await call('PATCH', `/api/workspace/zones/${zone.id}`, { collapsed: true })).json();
		expect(collapsed.collapsed).toBe(true);
		expect((await call('PATCH', `/api/workspace/zones/${zone.id}`, { collapsed: 'yes' })).status).toBe(400);
	});
});

describe('project roots', () => {
	it('groups subfolders under their git repository', () => {
		const repo = join(base, 'repo');
		mkdirSync(join(repo, '.git'), { recursive: true });
		mkdirSync(join(repo, 'web', 'src'), { recursive: true });
		const worktree = join(base, 'worktree');
		mkdirSync(join(worktree, 'pkg'), { recursive: true });
		writeFileSync(join(worktree, '.git'), 'gitdir: elsewhere\n');
		const plain = join(base, 'plain', 'sub');
		mkdirSync(plain, { recursive: true });

		const roots = new ProjectRootResolver();
		expect(roots.resolve(join(repo, 'web', 'src'))).toBe(repo);
		expect(roots.resolve(repo)).toBe(repo);
		expect(roots.resolve(join(worktree, 'pkg'))).toBe(worktree);
		expect(roots.resolve(plain)).toBe(plain);
		expect(roots.resolve(join(base, 'missing', 'dir'))).toBe(join(base, 'missing', 'dir'));
		expect(roots.resolve(null)).toBeNull();
	});

	it('is added to sessions by discovery', async () => {
		const repo = join(base, 'r2');
		mkdirSync(join(repo, '.git'), { recursive: true });
		mkdirSync(join(repo, 'api'), { recursive: true });
		const { discovery } = setup(join(repo, 'api'));
		const snapshot = await discovery.refresh();
		expect(snapshot.sessions[0]?.projectRoot).toBe(repo);
	});
});
