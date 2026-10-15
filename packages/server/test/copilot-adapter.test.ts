import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ParseCache, ProcessProbe, ScanResult, Session } from '@halcyon/core';
import { createCopilotAdapter } from '../src/adapters/copilot/copilot-adapter.js';
import { parseFlatYaml } from '../src/adapters/copilot/workspace-yaml.js';

// Synthetic fixtures only. All text, paths and IDs are invented.
const base = mkdtempSync(join(tmpdir(), 'halcyon-copilot-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const ID = {
	a: 'aaaaaaaa-1111-4111-8111-111111111111',
	b: 'bbbbbbbb-2222-4222-8222-222222222222',
	c: 'cccccccc-3333-4333-8333-333333333333',
	d: 'dddddddd-4444-4444-8444-444444444444',
	e: 'eeeeeeee-5555-4555-8555-555555555555'
};
const emptyCache: ParseCache = { get: () => undefined };

let rootCounter = 0;
function makeRoot(): string {
	const root = join(base, `root-${rootCounter++}`);
	mkdirSync(join(root, 'session-state'), { recursive: true });
	return root;
}

let seq = 0;
const ev = (type: string, data: object, extra: object = {}, minute = seq++) => ({
	id: `ev-${seq}`,
	timestamp: new Date(Date.parse('2026-09-01T10:00:00Z') + minute * 60_000).toISOString(),
	parentId: null,
	type,
	data,
	...extra
});
const start = (cwd = '/work/alpha', extra: object = {}) =>
	ev('session.start', { sessionId: 'x', startTime: '2026-09-01T09:59:00.000Z', context: { cwd }, ...extra }, {}, 0);

function addSession(stateDir: string, id: string, events: object[] | null, yaml: string | null = null, tail = '') {
	const dir = join(stateDir, id);
	mkdirSync(dir, { recursive: true });
	if (events) writeFileSync(join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n' + tail);
	if (yaml !== null) writeFileSync(join(dir, 'workspace.yaml'), yaml);
	return dir;
}

const scan = (root: string, cache: ParseCache = emptyCache, fallbackStateDirs: string[] = []) =>
	createCopilotAdapter({ root, fallbackStateDirs }).scan({ cache });
function byNative(result: ScanResult, nativeId: string): Session {
	const found = result.sessions.find((s) => s.session.nativeId === nativeId);
	if (!found) throw new Error(`session ${nativeId} not discovered`);
	return found.session;
}

function fakeProbe(processes: { pid: number; name: string; startedAtMs: number | null }[] | null): ProcessProbe & {
	calls: number;
} {
	const probe = {
		calls: 0,
		processes: async () => {
			probe.calls++;
			return processes;
		},
		openFiles: async () => null
	};
	return probe;
}

describe('Copilot adapter: detection', () => {
	it('reports unavailable when the Copilot home is missing', async () => {
		const result = await createCopilotAdapter({ root: join(base, 'missing') }).detect();
		expect(result.available).toBe(false);
		if (!result.available) expect(result.reason).toMatch(/No GitHub Copilot CLI sessions found/);
	});

	it('is available with no sessions when the home exists without session-state', async () => {
		const root = join(base, 'bare');
		mkdirSync(root, { recursive: true });
		const adapter = createCopilotAdapter({ root });
		expect((await adapter.detect()).available).toBe(true);
		expect(await adapter.scan({ cache: emptyCache })).toEqual({ sessions: [], warnings: [], parsedCount: 0 });
	});
});

describe('Copilot adapter: scan', () => {
	it('reads workspace.yaml and events, and skips subagent, detached and empty sessions', async () => {
		const root = makeRoot();
		const state = join(root, 'session-state');
		addSession(
			state,
			ID.a,
			[
				start('/work/alpha'),
				ev('user.message', { content: 'first prompt' }),
				ev('assistant.message', { content: 'reply' }),
				ev('user.message', { content: 'skill text', source: 'skill' }),
				ev('user.message', { content: 'continue', isAutopilotContinuation: true }),
				ev('user.message', { content: 'sub prompt' }, { agentId: 'sub-1' }),
				ev('session.title_changed', { title: 'Event title' }),
				ev('session.context_changed', { context: { cwd: '/work/alpha/pkg' } }),
				ev('user.message', { content: 'second prompt' })
			],
			[
				`id: ${ID.a}`,
				'cwd: /work/alpha',
				'name: "My: renamed session"',
				'user_named: true',
				"summary: 'A summary'",
				'created_at: 2026-09-01T09:59:00.000Z',
				'updated_at: "2026-09-03T12:00:00.000Z"',
				'nested:',
				'  name: ignored',
				''
			].join('\n')
		);
		addSession(state, ID.b, [start('/work/beta', { detachedFromSpawningParentSessionId: ID.a }), ev('user.message', { content: 'x' })]);
		addSession(state, ID.c, [start('/work/gamma'), ev('assistant.message', { content: 'hi' })]);
		addSession(state, ID.d, null, 'cwd: /work/delta\n');
		addSession(state, 'not-a-uuid', [start()]);

		const result = await scan(root);
		expect(result.sessions.map((s) => s.session.nativeId)).toEqual([ID.a]);
		expect(result.warnings).toEqual([
			{ code: 'unsupported-schema', message: expect.any(String), count: 1 }
		]);
		expect(byNative(result, ID.a)).toEqual({
			id: `copilot:${ID.a}`,
			provider: 'copilot',
			nativeId: ID.a,
			title: 'My: renamed session',
			titleSource: 'custom',
			projectPath: '/work/alpha',
			latestPath: '/work/alpha/pkg',
			startedAt: '2026-09-01T09:59:00.000Z',
			lastActivityAt: '2026-09-03T12:00:00.000Z',
			lastActivitySource: 'provider-index',
			userTurnCount: 2
		});
		expect(JSON.stringify(result)).not.toMatch(/prompt|reply/);
	});

	it('falls back to event title, then summary, then null, and to event timestamps', async () => {
		const root = makeRoot();
		const state = join(root, 'session-state');
		addSession(state, ID.a, [start(), ev('user.message', { content: 'p' }, {}, 5), ev('session.title_changed', { title: 'Event title' }, {}, 6)]);
		addSession(state, ID.b, [start(), ev('user.message', { content: 'p' })], 'summary: Generated summary\n');
		addSession(state, ID.c, [start(), ev('user.message', { content: 'p' })], 'name: auto name\n');
		addSession(state, ID.d, [start(), ev('user.message', { content: 'p' })]);
		const result = await scan(root);
		const a = byNative(result, ID.a);
		expect([a.title, a.titleSource]).toEqual(['Event title', 'provider-generated']);
		expect(a.lastActivityAt).toBe('2026-09-01T10:06:00.000Z');
		expect(a.lastActivitySource).toBe('transcript');
		expect([byNative(result, ID.b).title, byNative(result, ID.b).titleSource]).toEqual(['Generated summary', 'provider-generated']);
		expect([byNative(result, ID.c).title, byNative(result, ID.c).titleSource]).toEqual(['auto name', 'provider-generated']);
		expect([byNative(result, ID.d).title, byNative(result, ID.d).titleSource]).toEqual([null, null]);
	});

	it('counts malformed lines and tolerates a truncated tail without quoting content', async () => {
		const root = makeRoot();
		const state = join(root, 'session-state');
		addSession(
			state,
			ID.a,
			[start(), ev('user.message', { content: 'p' })],
			null,
			'{"type":"user.message" secret-ish\n{"id":"x","timestamp":"2026-09-01T11:00:00.000Z","type":"user.mes'
		);
		const result = await scan(root);
		expect(result.sessions[0]!.session.userTurnCount).toBe(1);
		expect(result.warnings).toEqual([{ code: 'malformed-records', message: expect.any(String), count: 1 }]);
		expect(JSON.stringify(result.warnings)).not.toContain('secret-ish');
	});

	it('reuses cached results and reparses when events or workspace.yaml change', async () => {
		const root = makeRoot();
		const state = join(root, 'session-state');
		const dir = addSession(state, ID.a, [start(), ev('user.message', { content: 'p' })], 'name: one\n');
		const first = await scan(root);
		expect(first.parsedCount).toBe(1);
		const entries = new Map(first.sessions.map((s) => [s.source.path, { ...s, parserVersion: 1 }]));
		const cache: ParseCache = { get: (p) => entries.get(p) };
		const second = await scan(root, cache);
		expect(second.parsedCount).toBe(0);
		expect(second.sessions).toEqual(first.sessions);

		writeFileSync(join(dir, 'workspace.yaml'), 'name: two\n');
		const later = new Date(Date.now() + 5000);
		utimesSync(join(dir, 'workspace.yaml'), later, later);
		const third = await scan(root, cache);
		expect(third.parsedCount).toBe(1);
		expect(third.sessions[0]!.session.title).toBe('two');
	});

	it('scans the XDG fallback store and de-duplicates by ID and real path', async () => {
		const root = makeRoot();
		const state = join(root, 'session-state');
		addSession(state, ID.a, [start(), ev('user.message', { content: 'p' })]);
		const fallback = join(base, `xdg-${rootCounter++}`, '.copilot', 'session-state');
		addSession(fallback, ID.a, [start(), ev('user.message', { content: 'p' })]);
		addSession(fallback, ID.b, [start(), ev('user.message', { content: 'p' })]);
		const alias = join(base, `alias-${rootCounter++}`);
		symlinkSync(state, alias); // the same store reached through another path
		const result = await scan(root, emptyCache, [fallback, alias]);
		expect(result.sessions.map((s) => s.session.nativeId).sort()).toEqual([ID.a, ID.b]);
		expect(result.sessions.find((s) => s.session.nativeId === ID.a)!.source.path.startsWith(state)).toBe(true);
	});

	it('parses only flat scalars from workspace.yaml', () => {
		const values = parseFlatYaml(
			['a: plain # comment', 'b: "esc\\"aped"', "c: 'it''s'", 'd: true', 'e: |', '  block', 'f:', '  - x', ' g: indented'].join('\n')
		);
		expect(Object.fromEntries(values)).toEqual({ a: 'plain', b: 'esc"aped', c: "it's", d: true });
	});
});

describe('Copilot adapter: actions, preview and live', () => {
	const session = (extra: Partial<Session> = {}): Session => ({
		id: `copilot:${ID.a}`,
		provider: 'copilot',
		nativeId: ID.a,
		title: null,
		titleSource: null,
		projectPath: '/work/alpha',
		latestPath: null,
		startedAt: null,
		lastActivityAt: null,
		lastActivitySource: null,
		userTurnCount: 1,
		...extra
	});

	it('builds an argv resume command and rejects invalid IDs', () => {
		const adapter = createCopilotAdapter({ root: base });
		expect(adapter.resumeCommand(session())).toEqual({ executable: 'copilot', args: ['--resume', ID.a], cwd: '/work/alpha' });
		expect(adapter.resumeCommand(session({ latestPath: '/work/alpha/pkg' }))?.cwd).toBe('/work/alpha/pkg');
		expect(adapter.resumeCommand(session({ nativeId: '--yolo' }))).toBeNull();
	});

	it('previews human prompts and assistant replies, bounded, skipping injected and subagent messages', async () => {
		const root = makeRoot();
		const state = join(root, 'session-state');
		addSession(state, ID.a, [
			start(),
			ev('user.message', { content: 'first prompt' }),
			ev('assistant.message', { content: 'first reply' }),
			ev('user.message', { content: 'skill body', source: 'skill' }),
			ev('user.message', { content: '<reminder>ctx</reminder>' }),
			ev('assistant.message', { content: 'sub reply' }, { agentId: 'sub' }),
			ev('user.message', { content: 'second prompt' }),
			ev('assistant.message', { content: 'y'.repeat(50) })
		]);
		const adapter = createCopilotAdapter({ root });
		const [found] = (await adapter.scan({ cache: emptyCache })).sessions;
		const messages = await adapter.preview!(found!.source.path, { limit: 3, maxChars: 10 });
		expect(messages.map((m) => [m.role, m.text])).toEqual([
			['assistant', 'first repl…'],
			['user', 'second pro…'],
			['assistant', `${'y'.repeat(10)}…`]
		]);
		expect(messages[1]!.at).toMatch(/^2026-09-01T/);
		await expect(adapter.preview!(join(base, 'x', 'events.jsonl'), { limit: 3, maxChars: 10 })).rejects.toThrow(/outside/);
		await expect(adapter.preview!(join(state, ID.a, 'workspace.yaml'), { limit: 3, maxChars: 10 })).rejects.toThrow(/outside/);
	});

	it('reports open sessions from in-use locks held by running processes only', async () => {
		const root = makeRoot();
		const state = join(root, 'session-state');
		const a = addSession(state, ID.a, [start()]);
		const b = addSession(state, ID.b, [start()]);
		const c = addSession(state, ID.c, [start()]);
		writeFileSync(join(a, 'inuse.101.lock'), '');
		writeFileSync(join(b, 'inuse.202.lock'), ''); // process gone
		writeFileSync(join(c, 'inuse.303.lock'), ''); // PID reused by a later process
		const adapter = createCopilotAdapter({ root });
		const live = await adapter.live!({
			probe: fakeProbe([
				{ pid: 101, name: 'node', startedAtMs: Date.now() - 60_000 },
				{ pid: 303, name: 'node', startedAtMs: Date.now() + 10 * 60_000 }
			])
		});
		expect(live).toEqual({
			state: 'ok',
			detail: 'presence',
			entries: [{ nativeId: ID.a, sourcePath: null, state: 'open', since: null }]
		});
	});

	it('reports no open sessions without locks, and unavailable when processes cannot be listed', async () => {
		const root = makeRoot();
		const state = join(root, 'session-state');
		const a = addSession(state, ID.a, [start()]);
		const probe = fakeProbe(null);
		const adapter = createCopilotAdapter({ root });
		expect(await adapter.live!({ probe })).toEqual({ state: 'ok', detail: 'presence', entries: [] });
		expect(probe.calls).toBe(0);
		writeFileSync(join(a, 'inuse.7.lock'), '');
		expect((await adapter.live!({ probe })).state).toBe('unavailable');
		expect((await createCopilotAdapter({ root: join(base, 'none') }).live!({ probe })).state).toBe('unavailable');
	});
});
