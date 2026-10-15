import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ParseCache, Session } from '@halcyon/core';
import { createKiloAdapter } from '../src/adapters/kilo/kilo-adapter.js';
import { openDatabase } from '../src/db/sqlite.js';

// Synthetic fixtures only. Kilo Code CLI shares OpenCode's schema, so this
// covers what differs: paths, provider ID, display name and executable.
const base = mkdtempSync(join(tmpdir(), 'halcyon-kilo-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const ID = 'ses_kkkkkkkkkkkkkkkkkkkkkkkkkk';
const CHILD = 'ses_llllllllllllllllllllllllll';
const emptyCache: ParseCache = { get: () => undefined };
const T0 = Date.parse('2026-04-01T08:00:00.000Z');

function makeDb(path: string) {
	mkdirSync(join(path, '..'), { recursive: true });
	const db = openDatabase(path);
	db.exec(`
		CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);
		CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL,
		  directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, time_created INTEGER NOT NULL,
		  time_updated INTEGER NOT NULL, time_archived INTEGER);
		CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
		  time_updated INTEGER NOT NULL, data TEXT NOT NULL);
		CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
		  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
	`);
	const session = db.prepare(
		`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
		 VALUES (?, 'p', ?, 's', '/work/kilo', 'Kilo task', '1', ?, ?)`
	);
	session.run(ID, null, T0, T0 + 1000);
	session.run(CHILD, ID, T0, T0 + 2000);
	db.prepare(`INSERT INTO message VALUES ('msg_1', ?, ?, ?, '{"role":"user"}')`).run(ID, T0, T0);
	db.prepare(`INSERT INTO part VALUES ('prt_1', 'msg_1', ?, ?, ?, '{"type":"text","text":"hello kilo"}')`).run(ID, T0, T0);
	db.close();
}

describe('Kilo Code adapter', () => {
	it('reads kilo.db under the data dir with the shared OpenCode parser', async () => {
		const root = join(base, 'data');
		makeDb(join(root, 'kilo.db'));
		const adapter = createKiloAdapter({ root });
		expect(adapter.provider).toBe('kilo');
		expect(adapter.displayName).toBe('Kilo Code');
		expect(await adapter.detect()).toEqual({ available: true, storePath: join(root, 'kilo.db') });
		const result = await adapter.scan({ cache: emptyCache });
		expect(result.sessions.map((entry) => entry.session)).toEqual([
			expect.objectContaining({ id: `kilo:${ID}`, provider: 'kilo', title: 'Kilo task', projectPath: '/work/kilo', userTurnCount: 1 })
		]);
		const preview = await adapter.preview!(result.sessions[0]!.source.path, { limit: 5, maxChars: 50 });
		expect(preview.map((message) => message.text)).toEqual(['hello kilo']);
	});

	it('defaults to $XDG_DATA_HOME/kilo/kilo.db and honours $KILO_DB', async () => {
		const xdg = join(base, 'xdg');
		makeDb(join(xdg, 'kilo', 'kilo.db'));
		makeDb(join(base, 'elsewhere', 'custom.db'));
		const saved = { xdg: process.env.XDG_DATA_HOME, db: process.env.KILO_DB };
		try {
			process.env.XDG_DATA_HOME = xdg;
			delete process.env.KILO_DB;
			expect(await createKiloAdapter().detect()).toEqual({ available: true, storePath: join(xdg, 'kilo', 'kilo.db') });
			process.env.KILO_DB = join(base, 'elsewhere', 'custom.db');
			expect(await createKiloAdapter().detect()).toEqual({ available: true, storePath: join(base, 'elsewhere', 'custom.db') });
		} finally {
			if (saved.xdg === undefined) delete process.env.XDG_DATA_HOME;
			else process.env.XDG_DATA_HOME = saved.xdg;
			if (saved.db === undefined) delete process.env.KILO_DB;
			else process.env.KILO_DB = saved.db;
		}
	});

	it('reports a missing store as unavailable', async () => {
		const root = join(base, 'none');
		expect(await createKiloAdapter({ root }).detect()).toEqual({
			available: false,
			reason: `No Kilo Code sessions found at ${join(root, 'kilo.db')}`
		});
	});

	it('resumes with the kilo executable and rejects invalid IDs', () => {
		const adapter = createKiloAdapter({ root: join(base, 'data') });
		const session = { provider: 'kilo', nativeId: ID, projectPath: '/work/kilo' } as Session;
		expect(adapter.resumeCommand(session)).toEqual({ executable: 'kilo', args: ['/work/kilo', '--session', ID], cwd: '/work/kilo' });
		expect(adapter.resumeCommand({ ...session, nativeId: 'ses_short' })).toBeNull();
		expect(adapter.resumeCommand({ ...session, provider: 'opencode' })).toBeNull();
	});
});
