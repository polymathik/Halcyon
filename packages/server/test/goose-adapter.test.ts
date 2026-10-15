import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ParseCache, ScanResult, Session } from '@halcyon/core';
import { createGooseAdapter } from '../src/adapters/goose/goose-adapter.js';
import { openDatabase, type Database } from '../src/db/sqlite.js';

// Synthetic fixtures only. All IDs, paths and text are invented.
const base = mkdtempSync(join(tmpdir(), 'halcyon-goose-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const emptyCache: ParseCache = { get: () => undefined };
const S0 = Date.parse('2026-06-01T09:00:00.000Z') / 1000;

const CURRENT_SCHEMA = `
CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  user_set_name BOOLEAN DEFAULT FALSE, session_type TEXT NOT NULL DEFAULT 'user', working_dir TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  extension_data TEXT DEFAULT '{}', archived_at TIMESTAMP, project_id TEXT, parent_session_id TEXT);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, session_id TEXT NOT NULL,
  role TEXT NOT NULL, content_json TEXT NOT NULL, created_timestamp INTEGER NOT NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP, tokens INTEGER, metadata_json TEXT);
`;

let counter = 0;
function newRoot(): string {
	const root = join(base, `root-${counter++}`);
	mkdirSync(join(root, 'sessions'), { recursive: true });
	return root;
}

function createDb(root: string, schema = CURRENT_SCHEMA): Database {
	const db = openDatabase(join(root, 'sessions', 'sessions.db'));
	db.exec(schema);
	return db;
}

function addSession(db: Database, row: Record<string, unknown>) {
	const columns = Object.keys(row);
	db.prepare(`INSERT INTO sessions (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(
		...(Object.values(row) as (string | number | null)[])
	);
}

function addMessage(db: Database, sessionId: string, role: string, content: unknown, at: number, metadata?: object) {
	db.prepare('INSERT INTO messages (session_id, role, content_json, created_timestamp, metadata_json) VALUES (?, ?, ?, ?, ?)').run(
		sessionId,
		role,
		typeof content === 'string' ? content : JSON.stringify(content),
		at,
		metadata ? JSON.stringify(metadata) : null
	);
}
const text = (value: string) => ({ type: 'text', text: value });

function standardDb(root: string): Database {
	const db = createDb(root);
	const common = { working_dir: '/work/goose', created_at: '2026-06-01 09:00:00', updated_at: '2026-06-01 09:01:00' };
	addSession(db, { id: '20260601_1', name: 'Plan the migration', user_set_name: 0, ...common });
	addSession(db, { id: '20260601_2', name: 'my release notes', user_set_name: 1, ...common, updated_at: '2026-06-01T10:00:00+00:00' });
	addSession(db, { id: '20260601_3', name: 'CLI Session', ...common });
	addSession(db, { id: '20260601_4', name: 'Subagent work', session_type: 'sub_agent', ...common });
	addSession(db, { id: '20260601_5', name: 'Hidden run', session_type: 'hidden', ...common });
	addSession(db, { id: '20260601_6', name: 'Child', parent_session_id: '20260601_1', ...common });
	addSession(db, { id: '20260601_7', name: 'Archived', archived_at: '2026-06-02 00:00:00', ...common });
	addSession(db, { id: '-oops', name: 'Bad ID', ...common });

	addMessage(db, '20260601_1', 'user', [text('migration question')], S0);
	addMessage(db, '20260601_1', 'assistant', [{ type: 'thinking', thinking: 'hmm' }, text('migration answer'), { type: 'toolRequest', id: 't1' }], S0 + 1);
	addMessage(db, '20260601_1', 'user', [{ type: 'toolResponse', id: 't1' }], S0 + 2);
	addMessage(db, '20260601_1', 'user', [text('hidden steer')], S0 + 3, { userVisible: false, agentVisible: true });
	addMessage(db, '20260601_1', 'user', [text('<system-reminder>ctx</system-reminder>second question')], S0 + 4, { userVisible: true });
	// Some rows store milliseconds.
	addMessage(db, '20260601_1', 'assistant', [text('second answer')], (S0 + 300) * 1000);
	addMessage(db, '20260601_1', 'user', '{"broken', S0 + 301);
	return db;
}

const byId = (result: ScanResult) => new Map(result.sessions.map((entry) => [entry.session.nativeId, entry.session]));

describe('Goose adapter', () => {
	it('lists interactive top-level sessions with names, times and turn counts', async () => {
		const root = newRoot();
		standardDb(root).close();
		const adapter = createGooseAdapter({ root });
		expect(await adapter.detect()).toEqual({ available: true, storePath: join(root, 'sessions', 'sessions.db') });
		const result = await adapter.scan({ cache: emptyCache });
		const sessions = byId(result);
		expect([...sessions.keys()].sort()).toEqual(['20260601_1', '20260601_2', '20260601_3']);

		expect(sessions.get('20260601_1')).toMatchObject({
			id: 'goose:20260601_1',
			title: 'Plan the migration',
			titleSource: 'provider-generated',
			projectPath: '/work/goose',
			startedAt: '2026-06-01T09:00:00.000Z',
			// The newest message is later than updated_at (a malformed row still has a time).
			lastActivityAt: '2026-06-01T09:05:01.000Z',
			lastActivitySource: 'transcript',
			// Tool responses, hidden messages and malformed rows do not count.
			userTurnCount: 2
		});
		expect(sessions.get('20260601_2')).toMatchObject({
			title: 'my release notes',
			titleSource: 'custom',
			lastActivityAt: '2026-06-01T10:00:00.000Z',
			userTurnCount: 0
		});
		// The default CLI name is a placeholder, not a title.
		expect(sessions.get('20260601_3')).toMatchObject({ title: null, titleSource: null });
		expect(result.sessions[0]!.session.nativeId).toBe('20260601_2');

		const warnings = result.warnings.map((warning) => warning.message).join('\n');
		expect(warnings).toMatch(/invalid ID/);
		expect(warnings).toMatch(/malformed content/);
		expect(JSON.stringify(result)).not.toContain('migration question');
	});

	it('tolerates an older schema without the newer columns', async () => {
		const root = newRoot();
		const db = createDb(
			root,
			`CREATE TABLE sessions (id TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', working_dir TEXT NOT NULL,
			   created_at TIMESTAMP, updated_at TIMESTAMP);
			 CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
			   content_json TEXT NOT NULL, created_timestamp INTEGER NOT NULL);`
		);
		addSession(db, { id: '20250101_1', description: 'Old style', working_dir: '/work/old', created_at: S0, updated_at: S0 });
		db.prepare('INSERT INTO messages (session_id, role, content_json, created_timestamp) VALUES (?, ?, ?, ?)').run(
			'20250101_1',
			'user',
			JSON.stringify([text('old prompt')]),
			S0
		);
		db.close();
		const result = await createGooseAdapter({ root }).scan({ cache: emptyCache });
		expect(result.sessions.map((entry) => entry.session)).toEqual([
			expect.objectContaining({ nativeId: '20250101_1', title: 'Old style', startedAt: '2026-06-01T09:00:00.000Z', userTurnCount: 1 })
		]);
	});

	it('reports a missing database and an unsupported schema as unavailable', async () => {
		const root = join(base, 'missing');
		expect(await createGooseAdapter({ root }).detect()).toEqual({
			available: false,
			reason: `No Goose sessions found at ${join(root, 'sessions', 'sessions.db')}`
		});
		const other = newRoot();
		createDb(other, 'CREATE TABLE sessions (id TEXT PRIMARY KEY)').close();
		const detected = await createGooseAdapter({ root: other }).detect();
		expect(detected.available).toBe(false);
	});

	it('uses $GOOSE_PATH_ROOT/data when it is absolute', async () => {
		const pathRoot = join(base, 'path-root');
		mkdirSync(join(pathRoot, 'data', 'sessions'), { recursive: true });
		createDb(join(pathRoot, 'data')).close();
		const saved = process.env.GOOSE_PATH_ROOT;
		process.env.GOOSE_PATH_ROOT = pathRoot;
		try {
			expect(await createGooseAdapter().detect()).toEqual({
				available: true,
				storePath: join(pathRoot, 'data', 'sessions', 'sessions.db')
			});
		} finally {
			if (saved === undefined) delete process.env.GOOSE_PATH_ROOT;
			else process.env.GOOSE_PATH_ROOT = saved;
		}
	});

	it('reads a WAL database while Goose writes to it', async () => {
		const root = newRoot();
		const writer = standardDb(root);
		try {
			const adapter = createGooseAdapter({ root });
			expect(byId(await adapter.scan({ cache: emptyCache })).has('20260602_1')).toBe(false);
			addSession(writer, { id: '20260602_1', name: 'Late', working_dir: '/work/late', created_at: '2026-06-02 00:00:00', updated_at: '2026-06-02 00:00:00' });
			expect(byId(await adapter.scan({ cache: emptyCache })).get('20260602_1')).toMatchObject({ projectPath: '/work/late' });
		} finally {
			writer.close();
		}
	});

	it('resumes with `goose session --resume --session-id` and rejects invalid IDs', () => {
		const adapter = createGooseAdapter({ root: newRoot() });
		const session = { provider: 'goose', nativeId: '20260601_1', projectPath: '/work/goose' } as Session;
		expect(adapter.resumeCommand(session)).toEqual({
			executable: 'goose',
			args: ['session', '--resume', '--session-id', '20260601_1'],
			cwd: '/work/goose'
		});
		expect(adapter.resumeCommand({ ...session, nativeId: '--fork' })).toBeNull();
		expect(adapter.resumeCommand({ ...session, provider: 'crush' })).toBeNull();
	});

	it('previews user-visible text only, bounded, from its own database', async () => {
		const root = newRoot();
		standardDb(root).close();
		const adapter = createGooseAdapter({ root });
		const source = `${join(root, 'sessions', 'sessions.db')}#20260601_1`;
		const preview = await adapter.preview!(source, { limit: 10, maxChars: 100 });
		expect(preview.map((message) => [message.role, message.text])).toEqual([
			['user', 'migration question'],
			['assistant', 'migration answer'],
			['user', 'second question'],
			['assistant', 'second answer']
		]);
		expect(preview[3]!.at).toBe('2026-06-01T09:05:00.000Z');
		const bounded = await adapter.preview!(source, { limit: 1, maxChars: 6 });
		expect(bounded).toEqual([expect.objectContaining({ text: 'second…', clipped: true })]);
		await expect(adapter.preview!(`${join(base, 'x.db')}#20260601_1`, { limit: 1, maxChars: 6 })).rejects.toThrow();
	});
});
