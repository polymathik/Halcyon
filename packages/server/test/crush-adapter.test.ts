import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ParseCache, ScanResult, Session } from '@halcyon/core';
import { createCrushAdapter } from '../src/adapters/crush/crush-adapter.js';
import { openDatabase, type Database } from '../src/db/sqlite.js';

// Synthetic fixtures only. All IDs, paths and text are invented.
const base = mkdtempSync(join(tmpdir(), 'halcyon-crush-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const ID = {
	a: 'aaaaaaaa-1111-4111-8111-111111111111',
	b: 'bbbbbbbb-2222-4222-8222-222222222222',
	task: 'call_task_1',
	late: 'cccccccc-3333-4333-8333-333333333333',
	other: 'dddddddd-4444-4444-8444-444444444444'
};
const emptyCache: ParseCache = { get: () => undefined };
const S0 = Date.parse('2026-05-01T12:00:00.000Z') / 1000;

let counter = 0;
function layout() {
	const dir = join(base, `case-${counter++}`);
	const project = join(dir, 'work', 'alpha');
	const nested = join(project, 'packages', 'web');
	const custom = join(dir, 'custom-data');
	const global = join(dir, 'global');
	mkdirSync(nested, { recursive: true });
	mkdirSync(join(project, '.crush'), { recursive: true });
	mkdirSync(custom, { recursive: true });
	mkdirSync(global, { recursive: true });
	return { dir, project, nested, custom, global };
}

function createDb(path: string): Database {
	const db = openDatabase(path);
	db.exec(`
		CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, title TEXT NOT NULL,
		  message_count INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0,
		  completion_tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0.0,
		  updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL, summary_message_id TEXT, todos TEXT, channel TEXT);
		CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
		  parts TEXT NOT NULL DEFAULT '[]', model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
		  finished_at INTEGER, provider TEXT, is_summary_message INTEGER DEFAULT 0 NOT NULL);
	`);
	return db;
}

function addSession(db: Database, id: string, title: string, parent: string | null = null, updated = S0 + 60) {
	db.prepare('INSERT INTO sessions (id, parent_session_id, title, updated_at, created_at) VALUES (?, ?, ?, ?, ?)').run(
		id,
		parent,
		title,
		updated,
		S0
	);
}

let messageCounter = 0;
function addMessage(db: Database, sessionId: string, role: string, parts: unknown, at = S0) {
	db.prepare('INSERT INTO messages (id, session_id, role, parts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
		`m${messageCounter++}`,
		sessionId,
		role,
		typeof parts === 'string' ? parts : JSON.stringify(parts),
		at,
		at
	);
}
const text = (value: string, hidden?: boolean) => ({ type: 'text', data: hidden ? { text: value, hidden } : { text: value } });

function registry(global: string, projects: unknown[]) {
	writeFileSync(join(global, 'projects.json'), JSON.stringify({ projects }));
}

function standard() {
	const paths = layout();
	const db = createDb(join(paths.project, '.crush', 'crush.db'));
	addSession(db, ID.a, 'Refactor the router', null, S0 + 120);
	addSession(db, ID.b, 'New Session');
	addSession(db, ID.task, 'Explore files', ID.a);
	addSession(db, `title-${ID.a}`, 'Generate a title', ID.a);
	addSession(db, '-bad id', 'Bad');
	addMessage(db, ID.a, 'user', [text('route question')], S0);
	addMessage(db, ID.a, 'assistant', [{ type: 'reasoning', data: { thinking: 'hmm' } }, text('route answer'), { type: 'finish', data: {} }], S0);
	addMessage(db, ID.a, 'tool', [{ type: 'tool_result', data: { content: 'output' } }], S0 + 1);
	addMessage(db, ID.a, 'user', [text('continue', true)], S0 + 2);
	addMessage(db, ID.a, 'user', [text('<system-reminder>x</system-reminder>follow up')], S0 + 3);
	addMessage(db, ID.a, 'assistant', [text('final answer')], S0 + 3);
	addMessage(db, ID.a, 'user', '[broken', S0 + 4);
	db.close();

	const otherDb = createDb(join(paths.custom, 'crush.db'));
	addSession(otherDb, ID.other, 'Custom data dir');
	otherDb.close();

	registry(paths.global, [
		// Most recent first. The nested project shares its parent's .crush folder.
		{ path: paths.nested, data_dir: join(paths.project, '.crush'), last_accessed: '2026-05-02T00:00:00Z' },
		{ path: paths.project, data_dir: join(paths.project, '.crush'), last_accessed: '2026-05-01T00:00:00Z' },
		{ path: join(paths.dir, 'gone'), data_dir: join(paths.dir, 'gone', '.crush'), last_accessed: '2026-04-01T00:00:00Z' },
		{ path: join(paths.dir, 'beta'), data_dir: paths.custom, last_accessed: '2026-04-01T00:00:00Z' },
		{ path: 'relative/path', data_dir: '.crush' }
	]);
	return paths;
}

const byId = (result: ScanResult) => new Map(result.sessions.map((entry) => [entry.session.nativeId, entry.session]));

describe('Crush adapter', () => {
	it('reads only registered project databases and lists top-level sessions', async () => {
		const paths = standard();
		const adapter = createCrushAdapter({ root: paths.global });
		expect(await adapter.detect()).toEqual({ available: true, storePath: join(paths.global, 'projects.json') });
		const result = await adapter.scan({ cache: emptyCache });
		const sessions = byId(result);
		expect([...sessions.keys()].sort()).toEqual([ID.a, ID.b, ID.other].sort());

		expect(sessions.get(ID.a)).toMatchObject({
			id: `crush:${ID.a}`,
			title: 'Refactor the router',
			titleSource: 'provider-generated',
			// The shared database belongs to the project that owns the .crush folder.
			projectPath: paths.project,
			startedAt: '2026-05-01T12:00:00.000Z',
			lastActivityAt: '2026-05-01T12:02:00.000Z',
			lastActivitySource: 'transcript',
			// Hidden continuations, tool messages and malformed rows do not count.
			userTurnCount: 2
		});
		expect(sessions.get(ID.b)).toMatchObject({ title: null, titleSource: null, userTurnCount: 0 });
		expect(sessions.get(ID.other)!.projectPath).toBe(join(paths.dir, 'beta'));

		const warnings = result.warnings.map((warning) => warning.message).join('\n');
		expect(warnings).toMatch(/1 registered Crush projects have no database/);
		expect(warnings).toMatch(/registry entries were malformed/);
		expect(warnings).toMatch(/invalid ID/);
		expect(warnings).toMatch(/malformed parts/);
		expect(JSON.stringify(result)).not.toContain('route question');
	});

	it('reports a missing or unreadable registry as unavailable', async () => {
		const paths = layout();
		expect(await createCrushAdapter({ root: paths.global }).detect()).toEqual({
			available: false,
			reason: `No Crush projects found at ${join(paths.global, 'projects.json')}`
		});
		writeFileSync(join(paths.global, 'projects.json'), '{"projects": [');
		const detected = await createCrushAdapter({ root: paths.global }).detect();
		expect(detected.available).toBe(false);
	});

	it('reads a WAL database while Crush writes to it', async () => {
		const paths = layout();
		const writer = createDb(join(paths.project, '.crush', 'crush.db'));
		try {
			registry(paths.global, [{ path: paths.project, data_dir: join(paths.project, '.crush') }]);
			const adapter = createCrushAdapter({ root: paths.global });
			expect((await adapter.scan({ cache: emptyCache })).sessions).toEqual([]);
			addSession(writer, ID.late, 'Late session');
			addMessage(writer, ID.late, 'user', [text('hi')]);
			const result = await adapter.scan({ cache: emptyCache });
			expect(result.sessions.map((entry) => [entry.session.nativeId, entry.session.userTurnCount])).toEqual([[ID.late, 1]]);
		} finally {
			writer.close();
		}
	});

	it('resumes with -c and -s, adding -D only for a non-default data dir', async () => {
		const paths = standard();
		const adapter = createCrushAdapter({ root: paths.global });
		const sessions = byId(await adapter.scan({ cache: emptyCache }));
		expect(adapter.resumeCommand(sessions.get(ID.a)!)).toEqual({
			executable: 'crush',
			args: ['-c', paths.project, '-s', ID.a],
			cwd: paths.project
		});
		expect(adapter.resumeCommand(sessions.get(ID.other)!)).toEqual({
			executable: 'crush',
			args: ['-c', join(paths.dir, 'beta'), '-D', paths.custom, '-s', ID.other],
			cwd: join(paths.dir, 'beta')
		});
		const session = sessions.get(ID.a)!;
		expect(adapter.resumeCommand({ ...session, nativeId: '-s' } as Session)).toBeNull();
		expect(adapter.resumeCommand({ ...session, projectPath: null })).toBeNull();
	});

	it('previews visible text from registered databases only', async () => {
		const paths = standard();
		const adapter = createCrushAdapter({ root: paths.global });
		const source = `${join(paths.project, '.crush', 'crush.db')}#${ID.a}`;
		const preview = await adapter.preview!(source, { limit: 10, maxChars: 100 });
		expect(preview.map((message) => [message.role, message.text])).toEqual([
			['user', 'route question'],
			['assistant', 'route answer'],
			['user', 'follow up'],
			['assistant', 'final answer']
		]);
		const bounded = await adapter.preview!(source, { limit: 1, maxChars: 5 });
		expect(bounded).toEqual([expect.objectContaining({ role: 'assistant', text: 'final…', clipped: true })]);

		const stray = join(paths.dir, 'stray.db');
		createDb(stray).close();
		await expect(adapter.preview!(`${stray}#${ID.a}`, { limit: 5, maxChars: 10 })).rejects.toThrow();
	});
});
