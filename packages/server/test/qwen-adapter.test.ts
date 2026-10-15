import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DiscoveredSession, ParseCache, ProcessProbe, ScanResult, Session } from '@halcyon/core';
import { qwenLive } from '../src/adapters/qwen/live.js';
import { createQwenAdapter } from '../src/adapters/qwen/qwen-adapter.js';

// Synthetic fixtures only: all IDs, paths, tokens and text are invented.
const base = mkdtempSync(join(tmpdir(), 'halcyon-qwen-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const emptyCache: ParseCache = { get: () => undefined };
const ID = {
	a: 'aaaaaaaa-1111-4111-8111-111111111111',
	b: 'bbbbbbbb-2222-4222-8222-222222222222',
	c: 'cccccccc-3333-4333-8333-333333333333',
	d: 'dddddddd-4444-4444-8444-444444444444'
};

let counter = 0;
function makeRoot(files: Record<string, string>): string {
	const root = join(base, `qwen-${counter++}`);
	mkdirSync(join(root, 'projects'), { recursive: true });
	for (const [rel, content] of Object.entries(files)) {
		const path = join(root, rel);
		mkdirSync(join(path, '..'), { recursive: true });
		writeFileSync(path, content);
	}
	return root;
}

const jsonl = (...records: object[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
let uuid = 0;
function rec(sessionId: string, type: string, timestamp: string, extra: object = {}) {
	return {
		uuid: `u${uuid++}`,
		parentUuid: null,
		sessionId,
		timestamp,
		type,
		cwd: '/work/alpha',
		version: '0.25.1',
		...extra
	};
}
const user = (id: string, at: string, text = 'please add tests', extra: object = {}) =>
	rec(id, 'user', at, { message: { role: 'user', parts: [{ text }] }, ...extra });
const assistant = (id: string, at: string, text = 'added', extra: object = {}) =>
	rec(id, 'assistant', at, { message: { role: 'model', parts: [{ text }] }, ...extra });
const title = (id: string, at: string, customTitle: string, titleSource: string) =>
	rec(id, 'system', at, { subtype: 'custom_title', systemPayload: { customTitle, titleSource } });

const chat = (project: string, id: string) => `projects/${project}/chats/${id}.jsonl`;

function find(result: ScanResult, nativeId: string): Session {
	const found = result.sessions.find((s) => s.session.nativeId === nativeId);
	if (!found) throw new Error(`session ${nativeId} not discovered`);
	return found.session;
}

describe('Qwen adapter: detection', () => {
	it('reports a missing store as unavailable', async () => {
		const result = await createQwenAdapter({ root: join(base, 'missing') }).detect();
		expect(result.available).toBe(false);
		if (!result.available) expect(result.reason).toMatch(/No Qwen Code sessions found/);
	});

	it('treats an empty projects directory as available with no sessions', async () => {
		const root = makeRoot({});
		const adapter = createQwenAdapter({ root });
		expect(await adapter.detect()).toEqual({ available: true, storePath: join(root, 'projects') });
		expect(await adapter.scan({ cache: emptyCache })).toEqual({ sessions: [], warnings: [], parsedCount: 0 });
	});
});

describe('Qwen adapter: scan', () => {
	it('reads identity, cwd, titles, turn counts and activity', async () => {
		const root = makeRoot({
			[chat('-work-alpha', ID.a)]: jsonl(
				user(ID.a, '2026-05-01T10:00:00.000Z'),
				assistant(ID.a, '2026-05-01T10:01:00.000Z'),
				rec(ID.a, 'tool_result', '2026-05-01T10:01:30.000Z'),
				user(ID.a, '2026-05-01T10:02:00.000Z', 'compressed', { subtype: 'chat_compression' }),
				title(ID.a, '2026-05-01T10:03:00.000Z', 'Auto title', 'auto'),
				title(ID.a, '2026-05-01T10:04:00.000Z', 'My name', 'manual'),
				user(ID.a, '2026-05-01T10:05:00.000Z', 'more', { cwd: '/work/alpha/sub' })
			),
			[chat('-work-beta', ID.b)]: jsonl(
				user(ID.b, '2026-04-01T09:00:00.000Z', 'x', { cwd: '/work/beta' }),
				title(ID.b, '2026-04-01T09:01:00.000Z', 'Generated', 'auto')
			),
			[chat('-work-gamma', ID.c)]: jsonl(
				rec(ID.c, 'system', '2026-04-02T00:00:00.000Z', { subtype: 'managed_session_header_v1', cwd: '/work/gamma' }),
				user(ID.c, '2026-04-02T00:01:00.000Z', 'x', { cwd: '/work/gamma' })
			)
		});
		const result = await createQwenAdapter({ root }).scan({ cache: emptyCache });
		expect(result.warnings).toEqual([]);
		expect(result.parsedCount).toBe(3);
		expect(find(result, ID.a)).toEqual({
			id: `qwen:${ID.a}`,
			provider: 'qwen',
			nativeId: ID.a,
			title: 'My name',
			titleSource: 'custom',
			projectPath: '/work/alpha',
			latestPath: '/work/alpha/sub',
			startedAt: '2026-05-01T10:00:00.000Z',
			lastActivityAt: '2026-05-01T10:05:00.000Z',
			lastActivitySource: 'transcript',
			userTurnCount: 2
		});
		expect(find(result, ID.b)).toMatchObject({ title: 'Generated', titleSource: 'provider-generated', projectPath: '/work/beta' });
		expect(find(result, ID.c)).toMatchObject({ projectPath: '/work/gamma', userTurnCount: 1 });
		expect(JSON.stringify(result)).not.toContain('please add tests');
	});

	it('skips archived sessions, sidecars, empty stubs and mismatched IDs', async () => {
		const root = makeRoot({
			[`projects/p/chats/archive/${ID.a}.jsonl`]: jsonl(user(ID.a, '2026-05-01T10:00:00.000Z')),
			[`projects/p/chats/${ID.a}.ledger.jsonl`]: jsonl(user(ID.a, '2026-05-01T10:00:00.000Z')),
			[`projects/p/chats/${ID.a}.worktree.json`]: '{}',
			[`projects/p/chats/${ID.a}.pr.json`]: '{}',
			[chat('p', ID.b)]: '',
			[chat('p', ID.c)]: jsonl(user(ID.d, '2026-05-01T10:00:00.000Z')),
			'projects/p/chats/notes.jsonl': jsonl(user(ID.d, '2026-05-01T10:00:00.000Z'))
		});
		const result = await createQwenAdapter({ root }).scan({ cache: emptyCache });
		expect(result.sessions).toEqual([]);
		expect(result.warnings).toEqual([expect.objectContaining({ code: 'index-mismatch', count: 1 })]);
	});

	it('tolerates malformed and truncated lines and falls back to file mtime', async () => {
		const file = chat('m', ID.a);
		const root = makeRoot({
			[file]:
				JSON.stringify({ sessionId: ID.a, type: 'user', cwd: '/work/m', message: { parts: [{ text: 'hi' }] } }) +
				'\n{broken\n{"sessionId":"' +
				ID.a +
				'","type":"assi',
			[chat('m', '0123456789abcdef0123456789abcdef')]: jsonl(user(ID.b, '2026-05-01T10:00:00.000Z'))
		});
		utimesSync(join(root, file), new Date('2026-03-03T03:03:03.000Z'), new Date('2026-03-03T03:03:03.000Z'));
		const result = await createQwenAdapter({ root }).scan({ cache: emptyCache });
		expect(result.sessions).toHaveLength(1);
		expect(find(result, ID.a)).toMatchObject({
			projectPath: '/work/m',
			startedAt: null,
			lastActivityAt: '2026-03-03T03:03:03.000Z',
			lastActivitySource: 'file-mtime',
			userTurnCount: 1
		});
		expect(result.warnings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: 'malformed-records', count: 1 }),
				expect.objectContaining({ code: 'unsupported-schema', count: 1 })
			])
		);
		for (const warning of result.warnings) expect(warning.message).not.toMatch(/broken/);
	});

	it('reuses cached results for unchanged files', async () => {
		const root = makeRoot({ [chat('c', ID.a)]: jsonl(user(ID.a, '2026-05-01T10:00:00.000Z')) });
		const adapter = createQwenAdapter({ root });
		const first = await adapter.scan({ cache: emptyCache });
		expect(first.parsedCount).toBe(1);
		const entries = new Map(first.sessions.map((s: DiscoveredSession) => [s.source.path, s]));
		const cache: ParseCache = {
			get: (path) => {
				const hit = entries.get(path);
				return hit ? { ...hit, parserVersion: adapter.parserVersion } : undefined;
			}
		};
		const second = await adapter.scan({ cache });
		expect(second.parsedCount).toBe(0);
		expect(second.sessions).toEqual(first.sessions);
	});
});

describe('Qwen adapter: resume and preview', () => {
	const session = (overrides: Partial<Session> = {}): Session => ({
		id: `qwen:${ID.a}`,
		provider: 'qwen',
		nativeId: ID.a,
		title: null,
		titleSource: null,
		projectPath: '/work/alpha',
		latestPath: null,
		startedAt: null,
		lastActivityAt: null,
		lastActivitySource: null,
		userTurnCount: null,
		...overrides
	});

	it('builds an argv resume command in the recorded cwd', () => {
		const adapter = createQwenAdapter({ root: join(base, 'x') });
		expect(adapter.resumeCommand(session())).toEqual({ executable: 'qwen', args: ['--resume', ID.a], cwd: '/work/alpha' });
		expect(adapter.resumeCommand(session({ nativeId: '--yolo' }))).toBeNull();
		expect(adapter.resumeCommand(session({ projectPath: null }))).toBeNull();
	});

	it('previews recent human and assistant text, bounded and wrapper-stripped', async () => {
		const root = makeRoot({
			[chat('v', ID.a)]: jsonl(
				user(ID.a, '2026-05-01T10:00:00.000Z', '<system-reminder>hidden context</system-reminder>'),
				user(ID.a, '2026-05-01T10:01:00.000Z', 'first <system-reminder>hidden context</system-reminder>question'),
				assistant(ID.a, '2026-05-01T10:02:00.000Z', 'first answer'),
				user(ID.a, '2026-05-01T10:03:00.000Z', 'summary text', { subtype: 'chat_compression' }),
				rec(ID.a, 'tool_result', '2026-05-01T10:04:00.000Z', { message: { role: 'user', parts: [{ text: 'tool out' }] } }),
				user(ID.a, '2026-05-01T10:05:00.000Z', 'y'.repeat(300)),
				rec(ID.a, 'assistant', '2026-05-01T10:06:00.000Z', {
					message: { role: 'model', parts: [{ text: 'pondering', thought: true }, { text: 'final answer' }] }
				})
			)
		});
		const adapter = createQwenAdapter({ root });
		const path = join(root, chat('v', ID.a));
		const messages = await adapter.preview!(path, { limit: 3, maxChars: 40 });
		expect(messages.map((m) => [m.role, m.text.slice(0, 12), m.clipped])).toEqual([
			['assistant', 'first answer', false],
			['user', 'y'.repeat(12), true],
			['assistant', 'final answer', false]
		]);
		const all = JSON.stringify(await adapter.preview!(path, { limit: 20, maxChars: 100 }));
		expect(all).toContain('first question');
		expect(all).not.toMatch(/hidden context|summary text|tool out|pondering/);
		await expect(adapter.preview!('/etc/passwd', { limit: 1, maxChars: 10 })).rejects.toThrow(/outside/);
	});
});

describe('Qwen adapter: live', () => {
	const probe = (processes: { pid: number; name: string; startedAtMs: number | null }[] | null): ProcessProbe => ({
		processes: async () => processes,
		openFiles: async () => null
	});
	const t0 = Date.parse('2026-05-01T10:00:00.000Z');
	const entry = (pid: number, sessionId: string, extra: object = {}) =>
		JSON.stringify({
			schemaVersion: 1,
			pid,
			procStart: '123',
			pidNs: null,
			sessionId,
			cwd: '/work/alpha',
			name: 'alpha',
			startedAt: t0,
			qwenVersion: '0.25.1',
			kind: 'tui',
			token: 'invented-secret-token',
			...extra
		});

	it('reports open sessions for live processes and ignores stale, reused, mismatched and foreign files', async () => {
		const home = makeRoot({
			'sessions/101.json': entry(101, ID.a),
			'sessions/102-0a1b2c3d.json': entry(102, ID.b.toUpperCase()),
			'sessions/103.json': entry(103, ID.c), // process not running
			'sessions/104.json': entry(104, ID.d), // PID reused
			'sessions/105.json': entry(999, ID.d), // pid disagrees with filename
			'sessions/106.json': '{oops',
			'sessions/2026-notes.json': entry(2026, ID.d),
			'sessions/107.json.0123456789ab.tmp': entry(107, ID.d)
		});
		const before = readdirSync(join(home, 'sessions')).sort();
		const live = await qwenLive(home, {
			probe: probe([
				{ pid: 101, name: 'node', startedAtMs: t0 - 1000 },
				{ pid: 102, name: 'node', startedAtMs: null },
				{ pid: 104, name: 'node', startedAtMs: t0 + 10 * 60_000 },
				{ pid: 105, name: 'node', startedAtMs: t0 },
				{ pid: 106, name: 'node', startedAtMs: t0 },
				{ pid: 107, name: 'node', startedAtMs: t0 }
			])
		});
		expect(live).toEqual({
			state: 'ok',
			detail: 'presence',
			entries: [
				{ nativeId: ID.a, sourcePath: null, state: 'open', since: null },
				{ nativeId: ID.b, sourcePath: null, state: 'open', since: null }
			]
		});
		expect(JSON.stringify(live)).not.toContain('invented-secret-token');
		// Stale files are left alone.
		expect(readdirSync(join(home, 'sessions')).sort()).toEqual(before);
	});

	it('distinguishes a missing registry, a missing home, and an unlistable process table', async () => {
		const home = makeRoot({});
		expect(await qwenLive(home, { probe: probe([]) })).toEqual({ state: 'ok', detail: 'presence', entries: [] });
		expect((await qwenLive(join(base, 'no-home'), { probe: probe([]) })).state).toBe('unavailable');
		const withEntry = makeRoot({ 'sessions/101.json': entry(101, ID.a) });
		expect((await qwenLive(withEntry, { probe: probe(null) })).state).toBe('unavailable');
		const adapter = createQwenAdapter({ root: withEntry });
		const viaAdapter = await adapter.live!({ probe: probe([{ pid: 101, name: 'node', startedAtMs: t0 }]) });
		expect(viaAdapter.state === 'ok' && viaAdapter.entries.map((e) => e.nativeId)).toEqual([ID.a]);
	});
});
