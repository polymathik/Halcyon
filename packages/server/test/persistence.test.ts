import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrations.js';
import { SessionCacheStore } from '../src/db/session-cache.js';
import { openDatabase } from '../src/db/sqlite.js';
import { WorkspaceStore } from '../src/db/workspace-store.js';
import { fixtureSession } from '../src/adapters/fixture-adapter.js';
import { ids, memoryDb } from './helpers.js';

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function insertZone(db: ReturnType<typeof memoryDb>, workspaceId: string): number {
	const result = db
		.prepare(
			"INSERT INTO zones (workspace_id, name, color, x, y, width, height, created_at) VALUES (?, 'Z', '#888', 0, 0, 100, 100, 'now')"
		)
		.run(workspaceId);
	return Number(result.lastInsertRowid);
}

describe('schema', () => {
	it('creates the default workspace and is idempotent', () => {
		const db = memoryDb();
		expect(migrate(db)).toBe(2);
		expect(new WorkspaceStore(db).get()?.name).toBe('Default');
	});

	it('refuses a database written by a newer release', () => {
		const db = memoryDb();
		db.exec('PRAGMA user_version = 99');
		expect(() => migrate(db)).toThrow(/newer/);
	});

	it('keeps a session in at most one zone, and only zones from its workspace', () => {
		const db = memoryDb();
		db.exec("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 'now')");
		const ownZone = insertZone(db, 'default');
		const foreignZone = insertZone(db, 'other');
		const sessionId = `claude:${ids.a}`;

		new WorkspaceStore(db).setPlacement(sessionId as `claude:${string}`, { x: 1, y: 2 });
		db.prepare('UPDATE card_placements SET zone_id = ? WHERE session_id = ?').run(ownZone, sessionId);
		expect(() =>
			db.prepare('UPDATE card_placements SET zone_id = ? WHERE session_id = ?').run(foreignZone, sessionId)
		).toThrow(/different workspace/);

		// Deleting the zone releases the card rather than deleting its placement.
		db.prepare('DELETE FROM zones WHERE id = ?').run(ownZone);
		expect(new WorkspaceStore(db).get()?.placements).toEqual([
			{ sessionId, x: 1, y: 2, zoneId: null }
		]);
	});

	it('preserves layout across a restart', () => {
		const dir = mkdtempSync(join(tmpdir(), 'halcyon-test-'));
		tempDirs.push(dir);
		const path = join(dir, 'halcyon.db');

		const first = openDatabase(path);
		migrate(first);
		new WorkspaceStore(first).setPlacement(`codex:${ids.b}`, { x: 40, y: -12.5 });
		new WorkspaceStore(first).setViewport({ x: 5, y: 6, zoom: 1.5 });
		first.close();

		const second = openDatabase(path);
		migrate(second);
		const workspace = new WorkspaceStore(second).get();
		second.close();
		expect(workspace?.placements).toEqual([{ sessionId: `codex:${ids.b}`, x: 40, y: -12.5, zoneId: null }]);
		expect(workspace?.viewport).toEqual({ x: 5, y: 6, zoom: 1.5 });
	});
});

describe('session cache', () => {
	const source = (path: string) => ({ path, sizeBytes: 10, mtimeMs: 1 });

	it('marks vanished sessions missing without touching other providers', () => {
		const db = memoryDb();
		const cache = new SessionCacheStore(db);
		const a = fixtureSession('claude', ids.a);
		const b = fixtureSession('claude', ids.b);
		const c = fixtureSession('codex', ids.c);
		cache.replaceProvider('claude', 1, [{ session: a, source: source('/a') }, { session: b, source: source('/b') }]);
		cache.replaceProvider('codex', 1, [{ session: c, source: source('/c') }]);

		cache.replaceProvider('claude', 1, [{ session: a, source: source('/a') }]);

		expect(cache.lastKnown('claude').map((s) => s.id)).toEqual([a.id]);
		expect(cache.lastKnown('codex').map((s) => s.id)).toEqual([c.id]);
		expect(cache.parseCache('claude').get('/a')?.parserVersion).toBe(1);
		expect(cache.parseCache('codex').get('/a')).toBeUndefined();
	});

	it('restores a session that reappears', () => {
		const db = memoryDb();
		const cache = new SessionCacheStore(db);
		const a = fixtureSession('claude', ids.a);
		cache.replaceProvider('claude', 1, [{ session: a, source: source('/a') }]);
		cache.replaceProvider('claude', 1, []);
		expect(cache.lastKnown('claude')).toEqual([]);
		cache.replaceProvider('claude', 1, [{ session: a, source: source('/a') }]);
		expect(cache.lastKnown('claude')).toEqual([a]);
	});
});
