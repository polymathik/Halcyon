import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DiscoveredSession, ParseCache, ScanResult } from '@halcyon/core';
import { createClaudeAdapter } from '../src/adapters/claude/claude-adapter.js';

// Synthetic, redacted fixtures. All text, paths and IDs are invented.
const base = mkdtempSync(join(tmpdir(), 'halcyon-claude-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const ID = {
	a: 'aaaaaaaa-1111-4111-8111-111111111111',
	b: 'bbbbbbbb-2222-4222-8222-222222222222',
	c: 'cccccccc-3333-4333-8333-333333333333',
	d: 'dddddddd-4444-4444-8444-444444444444'
};

const emptyCache: ParseCache = { get: () => undefined };

let rootCounter = 0;
function makeRoot(files: Record<string, string>): string {
	const root = join(base, `root-${rootCounter++}`);
	mkdirSync(join(root, 'projects'), { recursive: true });
	for (const [rel, content] of Object.entries(files)) {
		const path = join(root, 'projects', rel);
		mkdirSync(join(path, '..'), { recursive: true });
		writeFileSync(path, content);
	}
	return root;
}

const line = (record: object) => JSON.stringify(record);
const jsonl = (...records: object[]) => records.map(line).join('\n') + '\n';

function user(sessionId: string, timestamp: string, extra: object = {}, content: unknown = 'hello') {
	return {
		type: 'user',
		isSidechain: false,
		sessionId,
		timestamp,
		cwd: '/work/alpha',
		message: { role: 'user', content },
		...extra
	};
}
function assistant(sessionId: string, timestamp: string, extra: object = {}) {
	return {
		type: 'assistant',
		isSidechain: false,
		sessionId,
		timestamp,
		cwd: '/work/alpha',
		message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
		...extra
	};
}
const toolResult = [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'output' }];

async function scan(root: string, cache: ParseCache = emptyCache): Promise<ScanResult> {
	return createClaudeAdapter({ root }).scan({ cache });
}
function byNative(result: ScanResult, nativeId: string) {
	const found = result.sessions.find((s) => s.session.nativeId === nativeId);
	if (!found) throw new Error(`session ${nativeId} not discovered`);
	return found.session;
}

describe('Claude adapter: detection', () => {
	it('reports an unavailable store when the projects directory is missing', async () => {
		const result = await createClaudeAdapter({ root: join(base, 'does-not-exist') }).detect();
		expect(result.available).toBe(false);
		if (!result.available) expect(result.reason).toMatch(/No Claude Code session store/);
	});

	it('treats an existing but empty projects directory as available with no sessions', async () => {
		const root = makeRoot({});
		const adapter = createClaudeAdapter({ root });
		expect(await adapter.detect()).toEqual({ available: true, storePath: join(root, 'projects') });
		expect(await adapter.scan({ cache: emptyCache })).toEqual({ sessions: [], warnings: [], parsedCount: 0 });
	});
});

describe('Claude adapter: discovery', () => {
	it('enumerates only top-level UUID transcripts', async () => {
		const ok = jsonl(user(ID.a, '2026-01-01T00:00:00Z'));
		const root = makeRoot({
			[`-work-alpha/${ID.a}.jsonl`]: ok,
			[`-work-alpha/${ID.b}/subagents/agent-x.jsonl`]: ok,
			[`-work-alpha/${ID.b}/${ID.c}.jsonl`]: ok,
			['-work-alpha/notes.jsonl']: ok,
			['-work-alpha/sessions-index.json']: line({ entries: [{ sessionId: ID.d }] }),
			[`${ID.d}.jsonl`]: ok
		});
		const result = await scan(root);
		expect(result.sessions.map((s) => s.session.id)).toEqual([`claude:${ID.a}`]);
		expect(result.parsedCount).toBe(1);
	});

	it('extracts provider-scoped identity, paths, times and source fingerprint', async () => {
		const root = makeRoot({
			[`-work-alpha/${ID.a}.jsonl`]: jsonl(
				{ type: 'mode', mode: 'default' },
				// Unordered: the earliest record is not first, the latest is not last.
				assistant(ID.a, '2026-03-02T10:05:00.000Z'),
				user(ID.a, '2026-03-02T10:00:00.000Z'),
				user(ID.a, '2026-03-02T12:00:00.000Z', { cwd: '/work/alpha/sub' }),
				assistant(ID.a, '2026-03-02T11:00:00.000Z'),
				{ type: 'last-prompt', sessionId: ID.a }
			)
		});
		const { sessions } = await scan(root);
		expect(sessions).toHaveLength(1);
		const [found] = sessions as [DiscoveredSession];
		expect(found.session).toMatchObject({
			id: `claude:${ID.a}`,
			provider: 'claude',
			nativeId: ID.a,
			projectPath: '/work/alpha',
			latestPath: '/work/alpha/sub',
			startedAt: '2026-03-02T10:00:00.000Z',
			lastActivityAt: '2026-03-02T12:00:00.000Z',
			lastActivitySource: 'transcript',
			title: null,
			titleSource: null
		});
		expect(found.source.path).toBe(join(root, 'projects', '-work-alpha', `${ID.a}.jsonl`));
		expect(found.source.sizeBytes).toBeGreaterThan(0);
	});

	it('leaves latestPath null when the working directory never changes', async () => {
		const root = makeRoot({
			[`p/${ID.a}.jsonl`]: jsonl(user(ID.a, '2026-01-01T00:00:00Z'), assistant(ID.a, '2026-01-01T00:01:00Z'))
		});
		expect(byNative(await scan(root), ID.a).latestPath).toBeNull();
	});

	it('falls back to file mtime when no conversation record has a timestamp', async () => {
		const root = makeRoot({ [`p/${ID.a}.jsonl`]: jsonl({ type: 'ai-title', aiTitle: 'Only a title' }) });
		const session = byNative(await scan(root), ID.a);
		expect(session.startedAt).toBeNull();
		expect(session.lastActivitySource).toBe('file-mtime');
		expect(session.lastActivityAt).not.toBeNull();
		expect(session.projectPath).toBeNull();
	});
});

describe('Claude adapter: titles', () => {
	it('prefers the last custom title over provider-generated titles', async () => {
		const root = makeRoot({
			[`p/${ID.a}.jsonl`]: jsonl(
				{ type: 'custom-title', customTitle: 'First name', sessionId: ID.a },
				user(ID.a, '2026-01-01T00:00:00Z'),
				{ type: 'ai-title', aiTitle: 'Generated', sessionId: ID.a },
				{ type: 'custom-title', customTitle: 'Renamed', sessionId: ID.a },
				{ type: 'ai-title', aiTitle: 'Generated later', sessionId: ID.a }
			),
			[`p/${ID.b}.jsonl`]: jsonl(
				{ type: 'ai-title', aiTitle: 'Early guess', sessionId: ID.b },
				user(ID.b, '2026-01-01T00:00:00Z'),
				{ type: 'ai-title', aiTitle: 'Better guess', sessionId: ID.b },
				{ type: 'custom-title', customTitle: '   ', sessionId: ID.b }
			),
			[`p/${ID.c}.jsonl`]: jsonl(user(ID.c, '2026-01-01T00:00:00Z', {}, 'Please fix the build'))
		});
		const result = await scan(root);
		expect(byNative(result, ID.a)).toMatchObject({ title: 'Renamed', titleSource: 'custom' });
		expect(byNative(result, ID.b)).toMatchObject({ title: 'Better guess', titleSource: 'provider-generated' });
		// Never derived from prompt text.
		expect(byNative(result, ID.c)).toMatchObject({ title: null, titleSource: null });
	});
});

describe('Claude adapter: user turn count', () => {
	it('counts human-authored messages only', async () => {
		const t = '2026-01-01T00:00:00Z';
		const root = makeRoot({
			[`p/${ID.a}.jsonl`]: jsonl(
				user(ID.a, t, { origin: { kind: 'human' }, promptSource: 'typed' }), // 1
				user(ID.a, t, {}, [{ type: 'text', text: 'with image' }, { type: 'image' }]), // 2
				user(ID.a, t, {}, 'legacy record without origin'), // 3
				assistant(ID.a, t),
				user(ID.a, t, { toolUseResult: {} }, toolResult),
				user(ID.a, t, { isMeta: true }, 'injected context'),
				user(ID.a, t, { isSidechain: true }, 'subagent prompt'),
				user(ID.a, t, { isCompactSummary: true, isVisibleInTranscriptOnly: true }, 'summary'),
				user(ID.a, t, { origin: { kind: 'task-notification' }, promptSource: 'system' }, 'notice'),
				user(ID.a, t, { turnOrigin: 'task_notification' }, 'notice'),
				user(ID.a, t, {}, [])
			)
		});
		expect(byNative(await scan(root), ID.a).userTurnCount).toBe(3);
	});
});

describe('Claude adapter: damaged input', () => {
	it('skips a malformed middle line and a partial trailing line, counting only the former', async () => {
		const content =
			line(user(ID.a, '2026-01-01T00:00:00Z')) +
			'\n{"type":"user", this is not json\n' +
			line(user(ID.a, '2026-01-01T01:00:00Z')) +
			'\n{"type":"assistant","timestamp":"2026-01-01T05:00';
		const root = makeRoot({ [`p/${ID.a}.jsonl`]: content });
		const result = await scan(root);
		const session = byNative(result, ID.a);
		expect(session.userTurnCount).toBe(2);
		expect(session.lastActivityAt).toBe('2026-01-01T01:00:00.000Z');
		expect(result.warnings).toEqual([
			expect.objectContaining({ code: 'malformed-records', count: 1 })
		]);
		// Warnings describe problems without quoting record content.
		expect(JSON.stringify(result.warnings)).not.toContain('not json');
	});

	it('uses the filename ID when the recorded sessionId differs, and warns', async () => {
		const root = makeRoot({ [`p/${ID.a}.jsonl`]: jsonl(user(ID.b, '2026-01-01T00:00:00Z')) });
		const result = await scan(root);
		expect(byNative(result, ID.a).id).toBe(`claude:${ID.a}`);
		expect(result.sessions).toHaveLength(1);
		expect(result.warnings).toEqual([expect.objectContaining({ code: 'index-mismatch', count: 1 })]);
	});

	it.skipIf(process.getuid?.() === 0)('reports an unreadable file without failing the scan', async () => {
		const root = makeRoot({
			[`p/${ID.a}.jsonl`]: jsonl(user(ID.a, '2026-01-01T00:00:00Z')),
			[`p/${ID.b}.jsonl`]: jsonl(user(ID.b, '2026-01-01T00:00:00Z'))
		});
		const locked = join(root, 'projects', 'p', `${ID.b}.jsonl`);
		chmodSync(locked, 0o000);
		try {
			const result = await scan(root);
			expect(result.sessions.map((s) => s.session.nativeId)).toEqual([ID.a]);
			expect(result.warnings).toEqual([expect.objectContaining({ code: 'unreadable-file', count: 1 })]);
		} finally {
			chmodSync(locked, 0o644);
		}
	});
});

describe('Claude adapter: cache', () => {
	function cacheFrom(result: ScanResult, parserVersion = 1): ParseCache {
		const map = new Map(result.sessions.map((s) => [s.source.path, { ...s, parserVersion }]));
		return { get: (path) => map.get(path) };
	}

	it.skipIf(process.getuid?.() === 0)('reuses unchanged entries without reading the file', async () => {
		const root = makeRoot({ [`p/${ID.a}.jsonl`]: jsonl(user(ID.a, '2026-01-01T00:00:00Z')) });
		const first = await scan(root);
		expect(first.parsedCount).toBe(1);

		const path = join(root, 'projects', 'p', `${ID.a}.jsonl`);
		chmodSync(path, 0o000); // Any read attempt would now fail.
		try {
			const second = await scan(root, cacheFrom(first));
			expect(second.parsedCount).toBe(0);
			expect(second.warnings).toEqual([]);
			expect(second.sessions).toEqual(first.sessions);
		} finally {
			chmodSync(path, 0o644);
		}
	});

	it('reparses when the file changes or the parser version differs', async () => {
		const root = makeRoot({ [`p/${ID.a}.jsonl`]: jsonl(user(ID.a, '2026-01-01T00:00:00Z')) });
		const first = await scan(root);
		expect((await scan(root, cacheFrom(first, 0))).parsedCount).toBe(1);

		const path = join(root, 'projects', 'p', `${ID.a}.jsonl`);
		writeFileSync(path, jsonl(user(ID.a, '2026-01-01T00:00:00Z'), user(ID.a, '2026-01-02T00:00:00Z')));
		const changed = await scan(root, cacheFrom(first));
		expect(changed.parsedCount).toBe(1);
		expect(byNative(changed, ID.a).userTurnCount).toBe(2);
	});
});

describe('Claude adapter: abort and resume', () => {
	it('stops when the scan is aborted', async () => {
		const root = makeRoot({ [`p/${ID.a}.jsonl`]: jsonl(user(ID.a, '2026-01-01T00:00:00Z')) });
		const controller = new AbortController();
		controller.abort();
		await expect(
			createClaudeAdapter({ root }).scan({ cache: emptyCache, signal: controller.signal })
		).rejects.toThrow();
	});

	it('builds an argument-array resume command and rejects invalid IDs', async () => {
		const root = makeRoot({ [`p/${ID.a}.jsonl`]: jsonl(user(ID.a, '2026-01-01T00:00:00Z')) });
		const adapter = createClaudeAdapter({ root });
		const session = byNative(await adapter.scan({ cache: emptyCache }), ID.a);
		expect(adapter.resumeCommand(session)).toEqual({
			executable: 'claude',
			args: ['--resume', ID.a],
			cwd: '/work/alpha'
		});
		expect(adapter.resumeCommand({ ...session, nativeId: '--dangerous; rm -rf /' })).toBeNull();
	});
});
