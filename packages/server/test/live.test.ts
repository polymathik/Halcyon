import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessProbe, ProviderAdapter } from '@halcyon/core';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeLive } from '../src/adapters/claude/live.js';
import { codexLive } from '../src/adapters/codex/live.js';
import { createFixtureAdapter, fixtureSession } from '../src/adapters/fixture-adapter.js';
import { SessionCacheStore } from '../src/db/session-cache.js';
import { WorkspaceStore } from '../src/db/workspace-store.js';
import { DiscoveryService } from '../src/discovery/discovery-service.js';
import { createApp } from '../src/http/app.js';
import { LiveService } from '../src/live/live-service.js';
import { parseElapsed, parseLsofNames, parsePs } from '../src/live/process-probe.js';
import { ids, memoryDb } from './helpers.js';

// Synthetic fixtures only: invented PIDs, paths and IDs. No real process is inspected.
const base = mkdtempSync(join(tmpdir(), 'halcyon-live-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

function fakeProbe(
	processes: { pid: number; name: string; startedAtMs: number | null }[] | null,
	open: string[] | null = []
): ProcessProbe & { openCalls: number[][] } {
	const openCalls: number[][] = [];
	return {
		openCalls,
		processes: async () => processes,
		openFiles: async (pids) => {
			openCalls.push(pids);
			return open;
		}
	};
}

function claudeStore(entries: Record<string, object | string>): string {
	const root = mkdtempSync(join(base, 'claude-'));
	mkdirSync(join(root, 'sessions'));
	for (const [name, body] of Object.entries(entries)) {
		writeFileSync(join(root, 'sessions', name), typeof body === 'string' ? body : JSON.stringify(body));
	}
	return root;
}

describe('process probe parsing', () => {
	it('parses ps elapsed times and lines, including names with spaces', () => {
		expect(parseElapsed('05:09')).toBe(309);
		expect(parseElapsed('02:05:09')).toBe(7509);
		expect(parseElapsed('3-02:05:09')).toBe(3 * 86400 + 7509);
		expect(parseElapsed('nope')).toBeNull();
		const rows = parsePs('  41 01:00 /usr/local/bin/codex\n 77 3-00:00:01 /Applications/Some App.app/x/Helper\n\ngarbage\n', NOW);
		expect(rows).toEqual([
			{ pid: 41, name: 'codex', startedAtMs: NOW - 60_000 },
			{ pid: 77, name: 'Helper', startedAtMs: NOW - (3 * 86400 + 1) * 1000 }
		]);
	});

	it('reads only name lines from lsof field output', () => {
		expect(parseLsofNames('p41\nfcwd\nn/home/u\nf7\nn/home/u/.codex/sessions/x.jsonl\n')).toEqual([
			'/home/u',
			'/home/u/.codex/sessions/x.jsonl'
		]);
	});
});

describe('Claude Code session registry', () => {
	it('reports status for live processes and ignores stale, reused, malformed and foreign files', async () => {
		const started = NOW - 3_600_000;
		const root = claudeStore({
			'101.json': { pid: 101, sessionId: ids.a, startedAt: started, status: 'busy', statusUpdatedAt: NOW - 5_000 },
			'102.json': { pid: 102, sessionId: ids.b, startedAt: started, status: 'waiting' },
			'103.json': { pid: 103, sessionId: ids.c, startedAt: started }, // no status word → open
			'104.json': { pid: 104, sessionId: '7e9a0b1c-2d3e-4f50-8a6b-7c8d9e0f1a2b', startedAt: started, status: 'idle' }, // process gone
			'105.json': { pid: 105, sessionId: '8f0b1c2d-3e4f-4a61-9b7c-8d9e0f1a2b3c', startedAt: started, status: 'idle' }, // pid reused
			'106.json': '{ not json',
			'107.json': { pid: 107, sessionId: '../../etc/passwd', status: 'busy' },
			'101.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.key': 'secret',
			'notes.txt': 'ignored'
		});
		const probe = fakeProbe([
			{ pid: 101, name: 'claude', startedAtMs: started - 2_000 },
			{ pid: 102, name: 'node', startedAtMs: null },
			{ pid: 103, name: 'claude', startedAtMs: started },
			{ pid: 105, name: 'bash', startedAtMs: NOW - 1_000 },
			{ pid: 106, name: 'claude', startedAtMs: started },
			{ pid: 107, name: 'claude', startedAtMs: started }
		]);
		const live = await claudeLive(root, { probe });
		expect(live.state).toBe('ok');
		if (live.state !== 'ok') return;
		expect(live.detail).toBe('status');
		const byId = Object.fromEntries(live.entries.map((e) => [e.nativeId, e]));
		expect(Object.keys(byId).sort()).toEqual([ids.a, ids.b, ids.c].sort());
		expect(byId[ids.a]).toMatchObject({ state: 'working', since: new Date(NOW - 5_000).toISOString() });
		expect(byId[ids.b]).toMatchObject({ state: 'waiting', since: null });
		expect(byId[ids.c]!.state).toBe('open');
	});

	it('keeps the most recently updated entry when two processes claim one session', async () => {
		const root = claudeStore({
			'201.json': { sessionId: ids.a, status: 'idle', statusUpdatedAt: NOW - 60_000 },
			'202.json': { sessionId: ids.a, status: 'busy', statusUpdatedAt: NOW - 1_000 }
		});
		const live = await claudeLive(root, {
			probe: fakeProbe([
				{ pid: 201, name: 'claude', startedAtMs: null },
				{ pid: 202, name: 'claude', startedAtMs: null }
			])
		});
		expect(live.state === 'ok' && live.entries).toEqual([
			{ nativeId: ids.a, sourcePath: null, state: 'working', since: new Date(NOW - 1_000).toISOString() }
		]);
	});

	it('distinguishes a missing registry and an unlistable process table from no open sessions', async () => {
		const noRegistry = mkdtempSync(join(base, 'claude-old-'));
		expect((await claudeLive(noRegistry, { probe: fakeProbe([]) })).state).toBe('unavailable');
		const empty = claudeStore({});
		expect(await claudeLive(empty, { probe: fakeProbe(null) })).toEqual({ state: 'ok', detail: 'status', entries: [] });
		const one = claudeStore({ '1.json': { sessionId: ids.a, status: 'busy' } });
		expect((await claudeLive(one, { probe: fakeProbe(null) })).state).toBe('unavailable');
	});
});

describe('Codex open sessions', () => {
	const home = '/home/u/.codex';
	const rollout = (id: string) => `${home}/sessions/2026/10/14/rollout-2026-10-14T10-00-00-${id}.jsonl`;

	it('finds sessions from rollout files and writer locks held by codex processes', async () => {
		const probe = fakeProbe(
			[
				{ pid: 41, name: 'codex', startedAtMs: null },
				{ pid: 42, name: 'codex-aarch64-apple-darwin', startedAtMs: null },
				{ pid: 43, name: 'claude', startedAtMs: null }
			],
			[
				rollout(ids.a),
				`${home}/thread-writer-locks/${ids.a}.lock`,
				`${home}/thread-writer-locks/${ids.b.toUpperCase()}.lock`,
				`/elsewhere/rollout-2026-10-14T10-00-00-${ids.c}.jsonl`,
				`${home}/log/codex-tui.log`
			]
		);
		const live = await codexLive(home, { probe });
		expect(probe.openCalls).toEqual([[41, 42]]);
		expect(live).toEqual({
			state: 'ok',
			detail: 'presence',
			entries: [
				{ nativeId: ids.a, sourcePath: rollout(ids.a), state: 'open', since: null },
				{ nativeId: ids.b, sourcePath: null, state: 'open', since: null }
			]
		});
	});

	it('reports no open sessions when codex is not running, without listing files', async () => {
		const probe = fakeProbe([{ pid: 9, name: 'zsh', startedAtMs: null }]);
		expect(await codexLive(home, { probe })).toEqual({ state: 'ok', detail: 'presence', entries: [] });
		expect(probe.openCalls).toEqual([]);
	});

	it('stays unknown when codex runs but no session file can be identified, or lsof is missing', async () => {
		const running = [{ pid: 41, name: 'codex', startedAtMs: null }];
		expect((await codexLive(home, { probe: fakeProbe(running, [`${home}/log/codex-tui.log`]) })).state).toBe('unavailable');
		expect((await codexLive(home, { probe: fakeProbe(running, null) })).state).toBe('unavailable');
		expect((await codexLive(home, { probe: fakeProbe(null) })).state).toBe('unavailable');
	});
});

describe('GET /api/live', () => {
	const HOST = '127.0.0.1:4317';

	async function setup(adapters: ProviderAdapter[]) {
		const db = memoryDb();
		const discovery = new DiscoveryService(adapters, new SessionCacheStore(db));
		await discovery.refresh();
		let rescans = 0;
		const app = createApp({
			discovery,
			workspaces: new WorkspaceStore(db),
			allowedHosts: [HOST],
			webRoot: null,
			live: new LiveService({
				adapters,
				probe: fakeProbe([]),
				sessionForSource: (path) => discovery.sessionForSource(path),
				knownSessions: () => discovery.knownIds(),
				rescan: () => void rescans++
			})
		});
		const get = async () => {
			const res = await app.request('/api/live', { headers: { host: HOST } });
			return { res, body: await res.json() };
		};
		return { get, rescans: () => rescans };
	}

	it('maps entries to session IDs, keeps providers independent, and rescans once for undiscovered sessions', async () => {
		const claude = createFixtureAdapter('claude', [fixtureSession('claude', ids.a)]);
		claude.live = async () => ({
			state: 'ok',
			detail: 'status',
			entries: [
				{ nativeId: ids.a.toUpperCase(), sourcePath: null, state: 'waiting', since: null },
				{ nativeId: ids.c, sourcePath: null, state: 'working', since: null } // not discovered yet
			]
		});
		const codex = createFixtureAdapter('codex', [fixtureSession('codex', ids.b)]);
		codex.live = async () => {
			throw new Error('boom with /private/path');
		};
		const { get, rescans } = await setup([claude, codex]);
		const { res, body } = await get();
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(body.providers).toEqual([
			{ provider: 'claude', state: 'ok', detail: 'status' },
			{ provider: 'codex', state: 'error', reason: 'Live check failed' }
		]);
		// The undiscovered session is not reported; it triggers one rescan, and only one.
		expect(body.sessions).toEqual([{ sessionId: `claude:${ids.a}`, state: 'waiting', since: null }]);
		expect(rescans()).toBe(1);
		await new Promise((r) => setTimeout(r, 1_600)); // past the response cache
		await get();
		expect(rescans()).toBe(1);
	});

	it('omits providers without a live signal', async () => {
		const { body } = (await (await setup([createFixtureAdapter('claude', [])])).get());
		expect(body).toMatchObject({ providers: [], sessions: [] });
	});
});
