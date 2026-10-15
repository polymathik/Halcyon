import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DiscoveredSession, ParseCache, ProviderAdapter, ScanResult, Session } from '@halcyon/core';
import { createOpenCodeAdapter } from '../src/adapters/opencode/opencode-adapter.js';
import { openDatabase, type Database } from '../src/db/sqlite.js';

// Synthetic fixtures only. All IDs, paths and text are invented.
const base = mkdtempSync(join(tmpdir(), 'halcyon-opencode-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const ID = {
	a: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
	b: 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb',
	child: 'ses_cccccccccccccccccccccccccc',
	archived: 'ses_dddddddddddddddddddddddddd',
	global: 'ses_eeeeeeeeeeeeeeeeeeeeeeeeee',
	late: 'ses_ffffffffffffffffffffffffff'
};

const emptyCache: ParseCache = { get: () => undefined };
let counter = 0;
const newRoot = () => {
	const root = join(base, `root-${counter++}`);
	mkdirSync(root, { recursive: true });
	return root;
};

const SCHEMA = `
CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, sandboxes TEXT NOT NULL DEFAULT '[]');
CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT,
  slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT, title TEXT NOT NULL, version TEXT NOT NULL,
  share_url TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_compacting INTEGER,
  time_archived INTEGER);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
`;

const T0 = Date.parse('2026-03-01T10:00:00.000Z');

function createDb(path: string): Database {
	const db = openDatabase(path);
	db.exec(SCHEMA);
	return db;
}

function addSession(
	db: Database,
	id: string,
	extra: Partial<{ parent: string; directory: string; title: string; archived: number; project: string; updated: number }> = {}
) {
	db.prepare(
		`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived)
		 VALUES (?, ?, ?, 'slug', ?, ?, '1.19.0', ?, ?, ?)`
	).run(
		id,
		extra.project ?? 'prj_git',
		extra.parent ?? null,
		extra.directory ?? '/work/alpha',
		extra.title ?? 'Fix the parser',
		T0,
		extra.updated ?? T0 + 60_000,
		extra.archived ?? null
	);
}

let messageCounter = 0;
function addMessage(db: Database, sessionId: string, role: string, parts: object[], at = T0 + messageCounter * 1000) {
	const id = `msg_${String(messageCounter++).padStart(6, '0')}`;
	db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
		id,
		sessionId,
		at,
		at,
		JSON.stringify({ role, time: { created: at } })
	);
	parts.forEach((part, index) => {
		db.prepare(
			'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)'
		).run(`prt_${id}_${index}`, id, sessionId, at, at, JSON.stringify(part));
	});
	return id;
}

const text = (value: string, extra: object = {}) => ({ type: 'text', text: value, ...extra });

function standardDb(root: string): Database {
	const db = createDb(join(root, 'opencode.db'));
	db.prepare("INSERT INTO project (id, worktree, time_created, time_updated) VALUES ('prj_git', '/work/alpha', 0, 0)").run();
	db.prepare("INSERT INTO project (id, worktree, time_created, time_updated) VALUES ('global', '/', 0, 0)").run();
	addSession(db, ID.a, { updated: T0 + 120_000 });
	addSession(db, ID.b, { title: 'New session - 2026-03-01T10:00:00.000Z', directory: '' });
	addSession(db, ID.child, { parent: ID.a, title: 'Child session - 2026-03-01T10:00:00.000Z' });
	addSession(db, ID.archived, { archived: T0 + 1 });
	addSession(db, ID.global, { directory: '', project: 'global', title: 'Global chat' });
	addSession(db, 'not-an-opencode-id');

	addMessage(db, ID.a, 'user', [text('first question')]);
	addMessage(db, ID.a, 'assistant', [{ type: 'step-start' }, text('first answer'), { type: 'tool', tool: 'bash' }]);
	addMessage(db, ID.a, 'user', [text('Called the Read tool', { synthetic: true })]);
	addMessage(db, ID.a, 'user', [text('<system-reminder>injected</system-reminder>second question'), text('ignored', { ignored: true })]);
	addMessage(db, ID.a, 'assistant', [text('second answer')]);
	db.prepare(
		"INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_bad', ?, ?, ?, '{not json')"
	).run(ID.a, T0, T0);
	addMessage(db, ID.child, 'user', [text('child prompt')]);
	return db;
}

async function scan(adapter: ProviderAdapter, cache: ParseCache = emptyCache): Promise<ScanResult> {
	return adapter.scan({ cache });
}
const byId = (result: ScanResult) => new Map(result.sessions.map((entry) => [entry.session.nativeId, entry]));

describe('OpenCode adapter (SQLite)', () => {
	it('lists top-level, unarchived sessions with honest metadata', async () => {
		const root = newRoot();
		standardDb(root).close();
		const adapter = createOpenCodeAdapter({ root });
		expect(await adapter.detect()).toEqual({ available: true, storePath: join(root, 'opencode.db') });

		const result = await scan(adapter);
		const sessions = byId(result);
		expect([...sessions.keys()].sort()).toEqual([ID.a, ID.b, ID.global].sort());
		// Newest first, as OpenCode lists them.
		expect(result.sessions[0]!.session.nativeId).toBe(ID.a);

		const a = sessions.get(ID.a)!;
		expect(a.session).toMatchObject({
			id: `opencode:${ID.a}`,
			title: 'Fix the parser',
			titleSource: 'provider-generated',
			projectPath: '/work/alpha',
			startedAt: '2026-03-01T10:00:00.000Z',
			lastActivityAt: '2026-03-01T10:02:00.000Z',
			lastActivitySource: 'transcript',
			// Synthetic-only and malformed messages do not count.
			userTurnCount: 2
		});
		expect(a.source).toEqual({ path: `${join(root, 'opencode.db')}#${ID.a}`, sizeBytes: 0, mtimeMs: T0 + 120_000 });

		// The placeholder title is not a title; an empty directory falls back to the worktree.
		expect(sessions.get(ID.b)!.session).toMatchObject({ title: null, titleSource: null, projectPath: '/work/alpha', userTurnCount: 0 });
		// The global project's "/" worktree says nothing about the cwd.
		expect(sessions.get(ID.global)!.session.projectPath).toBeNull();

		const codes = result.warnings.map((warning) => warning.code);
		expect(codes).toContain('malformed-records');
		expect(JSON.stringify(result)).not.toContain('first question');
	});

	it('reports a missing store and an unsupported schema as unavailable', async () => {
		const root = newRoot();
		const missing = await createOpenCodeAdapter({ root }).detect();
		expect(missing).toEqual({ available: false, reason: `No OpenCode sessions found at ${join(root, 'opencode.db')}` });

		const db = openDatabase(join(root, 'opencode.db'));
		db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, name TEXT)');
		db.close();
		const adapter = createOpenCodeAdapter({ root });
		const detected = await adapter.detect();
		expect(detected.available).toBe(false);
		expect((detected as { reason: string }).reason).toMatch(/unsupported schema/);
		const result = await scan(adapter);
		expect(result.sessions).toEqual([]);
		expect(result.warnings[0]!.code).toBe('unsupported-schema');
	});

	it('honours $OPENCODE_DB relative to the XDG data dir', async () => {
		const xdg = newRoot();
		mkdirSync(join(xdg, 'opencode'));
		const db = createDb(join(xdg, 'opencode', 'custom.db'));
		addSession(db, ID.a);
		db.close();
		const saved = { xdg: process.env.XDG_DATA_HOME, db: process.env.OPENCODE_DB };
		process.env.XDG_DATA_HOME = xdg;
		process.env.OPENCODE_DB = 'custom.db';
		try {
			const adapter = createOpenCodeAdapter();
			expect(await adapter.detect()).toEqual({ available: true, storePath: join(xdg, 'opencode', 'custom.db') });
		} finally {
			if (saved.xdg === undefined) delete process.env.XDG_DATA_HOME;
			else process.env.XDG_DATA_HOME = saved.xdg;
			if (saved.db === undefined) delete process.env.OPENCODE_DB;
			else process.env.OPENCODE_DB = saved.db;
		}
	});

	it('reads a WAL database while another connection writes to it', async () => {
		const root = newRoot();
		const writer = standardDb(root);
		try {
			const adapter = createOpenCodeAdapter({ root });
			expect(byId(await scan(adapter)).has(ID.late)).toBe(false);
			addSession(writer, ID.late, { updated: T0 + 999_000 });
			addMessage(writer, ID.late, 'user', [text('late prompt')]);
			const result = await scan(adapter);
			expect(result.sessions[0]!.session).toMatchObject({ nativeId: ID.late, userTurnCount: 1 });
		} finally {
			writer.close();
		}
	});

	it('builds the resume command from argv only and rejects invalid IDs', () => {
		const adapter = createOpenCodeAdapter({ root: newRoot() });
		const session = { provider: 'opencode', nativeId: ID.a, projectPath: '/work/my project' } as Session;
		expect(adapter.resumeCommand(session)).toEqual({
			executable: 'opencode',
			args: ['/work/my project', '--session', ID.a],
			cwd: '/work/my project'
		});
		expect(adapter.resumeCommand({ ...session, projectPath: null })).toEqual({
			executable: 'opencode',
			args: ['--session', ID.a],
			cwd: null
		});
		expect(adapter.resumeCommand({ ...session, nativeId: '--help' })).toBeNull();
		expect(adapter.resumeCommand({ ...session, provider: 'kilo' })).toBeNull();
	});

	it('previews recent text messages, bounded and without injected or synthetic text', async () => {
		const root = newRoot();
		standardDb(root).close();
		const adapter = createOpenCodeAdapter({ root });
		const source = `${join(root, 'opencode.db')}#${ID.a}`;
		const all = await adapter.preview!(source, { limit: 10, maxChars: 100 });
		expect(all.map((message) => [message.role, message.text])).toEqual([
			['user', 'first question'],
			['assistant', 'first answer'],
			['user', 'second question'],
			['assistant', 'second answer']
		]);
		expect(all[0]!.at).toBe(new Date(all[0]!.at!).toISOString());

		const bounded = await adapter.preview!(source, { limit: 2, maxChars: 4 });
		expect(bounded).toEqual([
			expect.objectContaining({ role: 'user', text: 'seco…', clipped: true }),
			expect.objectContaining({ role: 'assistant', text: 'seco…', clipped: true })
		]);

		await expect(adapter.preview!(`${join(base, 'other.db')}#${ID.a}`, { limit: 2, maxChars: 10 })).rejects.toThrow();
		await expect(adapter.preview!(`${join(root, 'opencode.db')}#../x`, { limit: 2, maxChars: 10 })).rejects.toThrow();
	});
});

describe('OpenCode adapter (legacy JSON storage)', () => {
	function legacyRoot(): string {
		const root = newRoot();
		const storage = join(root, 'storage');
		const write = (rel: string, value: unknown) => {
			const path = join(storage, rel);
			mkdirSync(join(path, '..'), { recursive: true });
			writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
		};
		const session = (id: string, extra: object = {}) => ({
			id,
			slug: 'slug',
			projectID: 'prj1',
			directory: '/work/legacy',
			title: 'Legacy work',
			version: '1.1.65',
			time: { created: T0, updated: T0 + 5000 },
			...extra
		});
		write('project/prj1.json', { id: 'prj1', worktree: '/work/legacy' });
		write(`session/prj1/${ID.a}.json`, session(ID.a));
		write(`session/prj1/${ID.child}.json`, session(ID.child, { parentID: ID.a }));
		write(`session/prj1/${ID.archived}.json`, session(ID.archived, { time: { created: T0, updated: T0, archived: T0 } }));
		write(`session/prj1/${ID.b}.json`, '{"id": "ses_trunc');
		write(`message/${ID.a}/msg_001.json`, { id: 'msg_001', sessionID: ID.a, role: 'user', time: { created: T0 } });
		write(`part/msg_001/prt_001.json`, text('legacy question'));
		write(`message/${ID.a}/msg_002.json`, { id: 'msg_002', sessionID: ID.a, role: 'assistant', time: { created: T0 + 1000 } });
		write(`part/msg_002/prt_001.json`, { type: 'reasoning', text: 'thinking' });
		write(`part/msg_002/prt_002.json`, text('legacy answer'));
		write(`message/${ID.a}/msg_003.json`, { id: 'msg_003', sessionID: ID.a, role: 'user', time: { created: T0 + 2000 } });
		write(`part/msg_003/prt_001.json`, text('auto continue', { synthetic: true }));
		return root;
	}

	it('lists legacy sessions, skipping children, archived and malformed files', async () => {
		const root = legacyRoot();
		const adapter = createOpenCodeAdapter({ root });
		expect(await adapter.detect()).toEqual({ available: true, storePath: join(root, 'storage', 'session') });
		const result = await scan(adapter);
		expect(result.sessions.map((entry) => entry.session.nativeId)).toEqual([ID.a]);
		expect(result.sessions[0]!.session).toMatchObject({
			title: 'Legacy work',
			projectPath: '/work/legacy',
			startedAt: '2026-03-01T10:00:00.000Z',
			lastActivityAt: '2026-03-01T10:00:05.000Z',
			userTurnCount: 1
		});
		expect(result.warnings).toEqual([expect.objectContaining({ code: 'malformed-records', count: 1 })]);
	});

	it('reuses cached results for unchanged session files', async () => {
		const root = legacyRoot();
		const adapter = createOpenCodeAdapter({ root });
		const first = await scan(adapter);
		const entry = first.sessions[0]!;
		const cache: ParseCache = {
			get: (path) => (path === entry.source.path ? { ...entry, parserVersion: adapter.parserVersion } : undefined)
		};
		const second = await scan(adapter, cache);
		// Only the files that were not cached (child, archived, malformed) are read.
		expect(second.parsedCount).toBe(first.parsedCount - 1);
		expect(second.sessions).toEqual(first.sessions);

		const later = new Date(Date.now() + 3_600_000);
		utimesSync(entry.source.path, later, later);
		const third = await scan(adapter, cache);
		expect(third.parsedCount).toBe(first.parsedCount);
	});

	it('previews legacy messages from inside the store only', async () => {
		const root = legacyRoot();
		const adapter = createOpenCodeAdapter({ root });
		const [entry] = (await scan(adapter)).sessions as [DiscoveredSession];
		const preview = await adapter.preview!(entry.source.path, { limit: 5, maxChars: 50 });
		expect(preview.map((message) => [message.role, message.text])).toEqual([
			['user', 'legacy question'],
			['assistant', 'legacy answer']
		]);
		await expect(adapter.preview!(join(base, 'elsewhere.json'), { limit: 5, maxChars: 50 })).rejects.toThrow();
	});
});
