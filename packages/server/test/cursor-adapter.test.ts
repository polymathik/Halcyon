import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DiscoveredSession, ParseCache, ScanResult, Session } from '@halcyon/core';
import {
	createCursorAdapter,
	cursorBucket,
	cursorProjectSlug
} from '../src/adapters/cursor/cursor-adapter.js';
import { normalizeEpochMs } from '../src/adapters/cursor/store-meta.js';
import { cursorUserText } from '../src/adapters/cursor/transcript.js';
import { openDatabase } from '../src/db/sqlite.js';

// Synthetic fixtures only. All text, paths and IDs are invented.
const base = mkdtempSync(join(tmpdir(), 'halcyon-cursor-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const ID = {
	a: 'aaaaaaaa-1111-4111-8111-111111111111',
	b: 'bbbbbbbb-2222-4222-8222-222222222222',
	c: 'cccccccc-3333-4333-8333-333333333333',
	d: 'dddddddd-4444-4444-8444-444444444444',
	e: 'eeeeeeee-5555-4555-8555-555555555555',
	f: 'ffffffff-6666-4666-8666-666666666666'
};
const CWD = '/work/alpha';
const SECRET = 'SECRET-BLOB-KEY-do-not-leak';
const emptyCache: ParseCache = { get: () => undefined };

let rootCounter = 0;
function makeRoot(): string {
	const root = join(base, `root-${rootCounter++}`);
	mkdirSync(join(root, 'chats'), { recursive: true });
	return root;
}

function chatDir(root: string, id: string, cwd = CWD): string {
	const dir = join(root, 'chats', cursorBucket(cwd), id);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function addChat(root: string, id: string, meta: object | string | null, opts: { cwd?: string; db?: boolean } = {}) {
	const dir = chatDir(root, id, opts.cwd);
	if (opts.db !== false) writeFileSync(join(dir, 'store.db'), '');
	if (meta !== null) writeFileSync(join(dir, 'meta.json'), typeof meta === 'string' ? meta : JSON.stringify(meta));
	return dir;
}

function addTranscript(root: string, cwd: string, id: string, records: object[], nested = true, tail = '') {
	const dir = join(root, 'projects', cursorProjectSlug(cwd), 'agent-transcripts', ...(nested ? [id] : []));
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${id}.jsonl`);
	writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n' + tail);
	return path;
}

const userLine = (query: string) => ({
	role: 'user',
	message: {
		content: [
			{
				type: 'text',
				text: `<user_info>OS: invented</user_info>\n<timestamp>Monday</timestamp>\n<user_query>${query}</user_query>`
			}
		]
	}
});
const assistantLine = (text: string) => ({ role: 'assistant', message: { content: [{ type: 'text', text }] } });
const toolLine = { role: 'tool', message: { content: [{ type: 'text', text: 'tool output' }] } };

const meta = (extra: object = {}) => ({
	schemaVersion: 1,
	createdAtMs: Date.parse('2026-09-01T10:00:00Z'),
	hasConversation: true,
	updatedAtMs: Date.parse('2026-09-02T11:00:00Z'),
	cwd: CWD,
	...extra
});

const scan = (root: string, cache: ParseCache = emptyCache) => createCursorAdapter({ root }).scan({ cache });
function byNative(result: ScanResult, nativeId: string): Session {
	const found = result.sessions.find((s) => s.session.nativeId === nativeId);
	if (!found) throw new Error(`session ${nativeId} not discovered`);
	return found.session;
}

function writeStoreMeta(dir: string, value: object, wal = false) {
	const db = openDatabase(join(dir, 'store.db'));
	if (!wal) db.exec('PRAGMA journal_mode = DELETE;');
	db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
	db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('0', ?)").run(
		Buffer.from(JSON.stringify(value), 'utf8').toString('hex')
	);
	return db;
}

describe('Cursor adapter: detection', () => {
	it('reports unavailable when the config root is missing', async () => {
		const result = await createCursorAdapter({ root: join(base, 'missing') }).detect();
		expect(result.available).toBe(false);
		if (!result.available) expect(result.reason).toMatch(/No Cursor CLI sessions found/);
	});

	it('is available with no sessions when the root exists without chats', async () => {
		const root = join(base, 'bare');
		mkdirSync(root, { recursive: true });
		const adapter = createCursorAdapter({ root });
		expect((await adapter.detect()).available).toBe(true);
		expect(await adapter.scan({ cache: emptyCache })).toEqual({ sessions: [], warnings: [], parsedCount: 0 });
	});
});

describe('Cursor adapter: scan', () => {
	it('lists chats like `agent ls` and reads metadata and turn counts', async () => {
		const root = makeRoot();
		addChat(root, ID.a, meta({ title: 'Fix the parser' }));
		addTranscript(root, CWD, ID.a, [userLine('one'), assistantLine('ok'), toolLine, userLine('two'), assistantLine('done')]);
		addChat(root, ID.b, meta({ isSubagent: true }));
		addChat(root, ID.c, meta({ hasConversation: false }));
		addChat(root, ID.d, meta(), { db: false });
		addChat(root, ID.e, meta({ updatedAtMs: 0, title: 'New Agent' }));
		const dbPath = join(root, 'chats', cursorBucket(CWD), ID.e, 'store.db');
		utimesSync(dbPath, new Date('2026-09-05T00:00:00Z'), new Date('2026-09-05T00:00:00Z'));

		const result = await scan(root);
		expect(result.sessions.map((s) => s.session.nativeId).sort()).toEqual([ID.a, ID.e]);
		expect(result.warnings).toEqual([]);
		expect(result.parsedCount).toBe(1);

		expect(byNative(result, ID.a)).toEqual({
			id: `cursor:${ID.a}`,
			provider: 'cursor',
			nativeId: ID.a,
			title: 'Fix the parser',
			titleSource: 'provider-generated',
			projectPath: CWD,
			latestPath: null,
			startedAt: '2026-09-01T10:00:00.000Z',
			lastActivityAt: '2026-09-02T11:00:00.000Z',
			lastActivitySource: 'provider-index',
			userTurnCount: 2
		});
		const e = byNative(result, ID.e);
		expect(e.title).toBeNull();
		expect(e.titleSource).toBeNull();
		expect(e.userTurnCount).toBeNull();
		expect(e.lastActivityAt).toBe('2026-09-05T00:00:00.000Z');
		expect(e.lastActivitySource).toBe('file-mtime');
	});

	it('finds the older flat transcript layout', async () => {
		const root = makeRoot();
		addChat(root, ID.a, meta());
		const path = addTranscript(root, CWD, ID.a, [userLine('one')], false);
		const result = await scan(root);
		expect(result.sessions[0]!.source.path).toBe(path);
		expect(result.sessions[0]!.session.userTurnCount).toBe(1);
	});

	it('counts malformed transcript lines, tolerates a truncated tail, and flags a bucket mismatch', async () => {
		const root = makeRoot();
		// Stored under the bucket for a different folder than meta.json records.
		addChat(root, ID.a, meta({ cwd: '/work/beta' }));
		addTranscript(root, '/work/beta', ID.a, [userLine('one')], true, '{"role":"user" not json\n{"role":"user","mess');
		addChat(root, ID.b, '{"createdAtMs":', {}); // invalid meta.json and empty store.db
		addChat(root, 'not-a-uuid', meta());

		const result = await scan(root);
		expect(result.sessions.map((s) => s.session.nativeId)).toEqual([ID.a]);
		expect(result.sessions[0]!.session.userTurnCount).toBe(1);
		const codes = Object.fromEntries(result.warnings.map((w) => [w.code, w.count]));
		expect(codes['malformed-records']).toBe(1);
		expect(codes['index-mismatch']).toBe(1);
		expect(codes['unreadable-file']).toBe(1);
		expect(codes['unsupported-schema']).toBe(1);
		expect(JSON.stringify(result.warnings)).not.toMatch(/not json/);
	});

	it('reuses cached results for unchanged chats and reparses changed transcripts', async () => {
		const root = makeRoot();
		addChat(root, ID.a, meta());
		const path = addTranscript(root, CWD, ID.a, [userLine('one')]);
		const first = await scan(root);
		expect(first.parsedCount).toBe(1);

		const entries = new Map(first.sessions.map((s) => [s.source.path, { ...s, parserVersion: 1 }]));
		const cache: ParseCache = { get: (p) => entries.get(p) };
		const second = await scan(root, cache);
		expect(second.parsedCount).toBe(0);
		expect(second.sessions).toEqual(first.sessions);

		writeFileSync(path, [userLine('one'), userLine('two')].map((r) => JSON.stringify(r)).join('\n') + '\n');
		const third = await scan(root, cache);
		expect(third.parsedCount).toBe(1);
		expect(third.sessions[0]!.session.userTurnCount).toBe(2);
	});

	it('falls back to the store meta row without exposing the blob key, and never writes meta.json', async () => {
		const root = makeRoot();
		const dir = chatDir(root, ID.a);
		const db = writeStoreMeta(dir, {
			agentId: ID.a,
			latestRootBlobId: 'abc123',
			name: 'Store title',
			createdAt: Date.parse('2026-09-01T10:00:00Z') / 1000,
			lastUsedModel: 'invented-model',
			blobEncryptionKey: SECRET
		});
		db.close();
		const dirB = chatDir(root, ID.b);
		writeStoreMeta(dirB, { agentId: ID.b, latestRootBlobId: 'x', subagentInfo: { parent: ID.a }, createdAt: 1 }).close();
		const dirC = chatDir(root, ID.c);
		writeStoreMeta(dirC, { agentId: ID.c, latestRootBlobId: '', createdAt: 1 }).close();

		const result = await scan(root);
		expect(result.sessions.map((s) => s.session.nativeId)).toEqual([ID.a]);
		const session = result.sessions[0]!.session;
		expect(session.title).toBe('Store title');
		expect(session.startedAt).toBe('2026-09-01T10:00:00.000Z');
		expect(session.projectPath).toBeNull();
		expect(session.lastActivitySource).toBe('file-mtime');
		expect(JSON.stringify(result)).not.toContain(SECRET);
		const { existsSync } = await import('node:fs');
		expect(existsSync(join(dir, 'meta.json'))).toBe(false);
		// No cwd: resume is not possible.
		expect(createCursorAdapter({ root }).resumeCommand(session)).toBeNull();
	});

	it('reads a WAL store while another connection holds uncheckpointed writes', async () => {
		const root = makeRoot();
		const dir = chatDir(root, ID.f);
		const writer = writeStoreMeta(dir, { agentId: ID.f, latestRootBlobId: 'r1', name: 'WAL chat', createdAt: 1.7e12 }, true);
		try {
			writer.exec('PRAGMA wal_autocheckpoint = 0;');
			writer
				.prepare("UPDATE meta SET value = ? WHERE key = '0'")
				.run(Buffer.from(JSON.stringify({ agentId: ID.f, latestRootBlobId: 'r2', name: 'WAL renamed', createdAt: 1.7e12, blobEncryptionKey: SECRET })).toString('hex'));
			const result = await scan(root);
			expect(result.sessions.map((s) => s.session.title)).toEqual(['WAL renamed']);
			expect(JSON.stringify(result)).not.toContain(SECRET);
		} finally {
			writer.close();
		}
	});

	it('normalizes store timestamps in s, ms, us and ns', () => {
		const ms = Date.parse('2026-09-01T10:00:00Z');
		expect(normalizeEpochMs(ms / 1000)).toBe(ms);
		expect(normalizeEpochMs(ms)).toBe(ms);
		expect(normalizeEpochMs(ms * 1000)).toBe(ms);
		expect(normalizeEpochMs(ms * 1e6)).toBe(ms);
		expect(normalizeEpochMs('x')).toBeNull();
	});
});

describe('Cursor adapter: actions and preview', () => {
	const session = (extra: Partial<Session> = {}): Session => ({
		id: `cursor:${ID.a}`,
		provider: 'cursor',
		nativeId: ID.a,
		title: null,
		titleSource: null,
		projectPath: CWD,
		latestPath: null,
		startedAt: null,
		lastActivityAt: null,
		lastActivitySource: null,
		userTurnCount: null,
		...extra
	});

	it('builds an argv resume command in the session folder and rejects bad IDs or unknown cwd', () => {
		const adapter = createCursorAdapter({ root: base });
		expect(adapter.resumeCommand(session())).toEqual({ executable: 'cursor-agent', args: ['--resume', ID.a], cwd: CWD });
		expect(adapter.resumeCommand(session({ nativeId: '--help' }))).toBeNull();
		expect(adapter.resumeCommand(session({ projectPath: null }))).toBeNull();
	});

	it('previews user queries and assistant text, bounded and wrapper-stripped', async () => {
		const root = makeRoot();
		addChat(root, ID.a, meta());
		const long = 'x'.repeat(100);
		addTranscript(root, CWD, ID.a, [
			userLine('first question'),
			assistantLine('first answer'),
			toolLine,
			{ role: 'user', message: { content: [{ type: 'text', text: '<user_info>only context</user_info>' }] } },
			userLine('second question'),
			assistantLine(long)
		]);
		const adapter = createCursorAdapter({ root });
		const [found] = (await adapter.scan({ cache: emptyCache })).sessions as DiscoveredSession[];
		const messages = await adapter.preview!(found!.source.path, { limit: 3, maxChars: 20 });
		expect(messages.map((m) => [m.role, m.text, m.clipped])).toEqual([
			['assistant', 'first answer', false],
			['user', 'second question', false],
			['assistant', `${'x'.repeat(20)}…`, true]
		]);
		expect(messages.every((m) => m.at === null)).toBe(true);
		await expect(adapter.preview!(join(base, 'elsewhere.jsonl'), { limit: 3, maxChars: 20 })).rejects.toThrow(/outside/);
	});

	it('reduces injected user text to the typed query', () => {
		expect(cursorUserText('<timestamp>t</timestamp>\n<user_query>\nhello\n</user_query>')).toBe('hello');
		expect(cursorUserText('<timestamp>t</timestamp> plain prompt')).toBe('plain prompt');
		expect(cursorUserText('<user_info>x</user_info>')).toBeNull();
	});
});
