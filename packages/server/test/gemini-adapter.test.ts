import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DiscoveredSession, ParseCache, ScanResult, Session } from '@halcyon/core';
import { createGeminiAdapter } from '../src/adapters/gemini/gemini-adapter.js';

// Synthetic fixtures only: all IDs, paths and text are invented.
const base = mkdtempSync(join(tmpdir(), 'halcyon-gemini-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const emptyCache: ParseCache = { get: () => undefined };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

const ID = {
	a: 'aaaaaaaa-1111-4111-8111-111111111111',
	b: 'bbbbbbbb-2222-4222-8222-222222222222',
	c: 'cccccccc-3333-4333-8333-333333333333',
	d: 'dddddddd-4444-4444-8444-444444444444',
	e: 'eeeeeeee-5555-4555-8555-555555555555'
};

let counter = 0;
/** Creates `<home>/.gemini` with files relative to it; returns the global dir. */
function makeRoot(files: Record<string, string>): string {
	const root = join(base, `home-${counter++}`, '.gemini');
	mkdirSync(join(root, 'tmp'), { recursive: true });
	for (const [rel, content] of Object.entries(files)) {
		const path = join(root, rel);
		mkdirSync(join(path, '..'), { recursive: true });
		writeFileSync(path, content);
	}
	return root;
}

const jsonl = (...records: object[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
const meta = (sessionId: string, extra: object = {}) => ({
	sessionId,
	projectHash: 'p'.repeat(64),
	startTime: '2026-05-01T10:00:00.000Z',
	lastUpdated: '2026-05-01T10:05:00.000Z',
	...extra
});
const userMsg = (id: string, content: unknown = 'please refactor the parser', at = '2026-05-01T10:01:00.000Z') => ({
	id,
	timestamp: at,
	type: 'user',
	content
});
const geminiMsg = (id: string, content: unknown = 'done', extra: object = {}) => ({
	id,
	timestamp: '2026-05-01T10:02:00.000Z',
	type: 'gemini',
	content,
	...extra
});

async function scan(root: string, cache: ParseCache = emptyCache): Promise<ScanResult> {
	return createGeminiAdapter({ root }).scan({ cache });
}
function find(result: ScanResult, nativeId: string): Session {
	const found = result.sessions.find((s) => s.session.nativeId === nativeId);
	if (!found) throw new Error(`session ${nativeId} not discovered`);
	return found.session;
}

describe('Gemini adapter: detection', () => {
	it('reports a missing store as unavailable', async () => {
		const result = await createGeminiAdapter({ root: join(base, 'nope', '.gemini') }).detect();
		expect(result.available).toBe(false);
		if (!result.available) expect(result.reason).toMatch(/No Gemini CLI sessions found/);
	});

	it('treats an empty tmp directory as available with no sessions', async () => {
		const root = makeRoot({});
		const adapter = createGeminiAdapter({ root });
		expect(await adapter.detect()).toEqual({ available: true, storePath: join(root, 'tmp') });
		expect(await adapter.scan({ cache: emptyCache })).toEqual({ sessions: [], warnings: [], parsedCount: 0 });
	});
});

describe('Gemini adapter: scan', () => {
	it('reads slug and hash project folders, titles from summary only, and turn counts', async () => {
		const legacyProject = '/work/legacy';
		const root = makeRoot({
			'projects.json': JSON.stringify({ projects: { '/work/alpha': 'alpha', [legacyProject]: 'legacy' } }),
			'tmp/alpha/.project_root': '/work/alpha\n',
			'tmp/alpha/chats/session-2026-05-01T10-00-aaaaaaaa.jsonl': jsonl(
				meta(ID.a),
				userMsg('m1'),
				geminiMsg('m2'),
				userMsg('m3', '/help'),
				userMsg('m4', [{ text: 'second prompt' }]),
				{ $set: { summary: 'Refactor parser', lastUpdated: '2026-05-01T11:00:00.000Z' } }
			),
			[`tmp/${sha(legacyProject)}/chats/session-2026-04-01T09-00-bbbbbbbb.json`]: JSON.stringify(
				{
					sessionId: ID.b,
					projectHash: sha(legacyProject),
					startTime: '2026-04-01T09:00:00.000Z',
					lastUpdated: '2026-04-01T09:30:00.000Z',
					messages: [userMsg('x1'), geminiMsg('x2')]
				},
				null,
				2
			),
			[`tmp/${'f'.repeat(64)}/chats/session-2026-04-02T09-00-cccccccc.jsonl`]: jsonl(meta(ID.c), userMsg('y1'))
		});

		const result = await scan(root);
		expect(result.warnings).toEqual([]);
		expect(result.parsedCount).toBe(3);

		const a = find(result, ID.a);
		expect(a).toMatchObject({
			id: `gemini:${ID.a}`,
			provider: 'gemini',
			title: 'Refactor parser',
			titleSource: 'provider-generated',
			projectPath: '/work/alpha',
			latestPath: null,
			startedAt: '2026-05-01T10:00:00.000Z',
			lastActivityAt: '2026-05-01T11:00:00.000Z',
			lastActivitySource: 'transcript',
			userTurnCount: 2
		});
		expect(JSON.stringify(result)).not.toContain('please refactor');

		expect(find(result, ID.b)).toMatchObject({ title: null, titleSource: null, projectPath: legacyProject, userTurnCount: 1 });
		// A hash folder with no registry entry has an unknown project.
		expect(find(result, ID.c).projectPath).toBeNull();
	});

	it('applies rewinds and patches, and hides sessions without resumable content', async () => {
		const root = makeRoot({
			'tmp/p/.project_root': '/work/p',
			'tmp/p/chats/session-2026-05-01T10-00-aaaaaaaa.jsonl': jsonl(
				meta(ID.a),
				userMsg('m1'),
				geminiMsg('m2'),
				userMsg('m3'),
				geminiMsg('m4'),
				{ $rewindTo: 'm3' },
				userMsg('m5', 'retry'),
				{ $patch: { removeIds: ['m1'] } }
			),
			// Only ignored user content and an empty reply: not resumable.
			'tmp/p/chats/session-2026-05-01T11-00-bbbbbbbb.jsonl': jsonl(
				meta(ID.b),
				userMsg('m1', '/stats'),
				userMsg('m2', '<session_context>env</session_context>'),
				geminiMsg('m3', '')
			),
			// Everything rewound away.
			'tmp/p/chats/session-2026-05-01T12-00-cccccccc.jsonl': jsonl(meta(ID.c), userMsg('m1'), { $rewindTo: 'm1' }),
			// Subagent sessions are never listed.
			'tmp/p/chats/session-2026-05-01T13-00-dddddddd.jsonl': jsonl(meta(ID.d, { kind: 'subagent' }), userMsg('m1')),
			'tmp/p/chats/child/session-2026-05-01T14-00-eeeeeeee.jsonl': jsonl(meta(ID.e), userMsg('m1')),
			'tmp/p/chats/checkpoint-x.json': '{}',
			'tmp/p/chats/logs.json': '[]',
			'tmp/p/chats/session-2026-05-01T15-00-eeeeeeee.jsonl.unreadable-1': jsonl(meta(ID.e), userMsg('m1')),
			'tmp/p/chats/session-2026-05-01T15-00-eeeeeeee.jsonl.tmp-1': jsonl(meta(ID.e), userMsg('m1')),
			'tmp/bin/chats/session-2026-05-01T16-00-eeeeeeee.jsonl': jsonl(meta(ID.e), userMsg('m1'))
		});
		const result = await scan(root);
		expect(result.sessions.map((s) => s.session.nativeId)).toEqual([ID.a]);
		// m1 removed, m3+m4 rewound: only m5 remains as a user turn.
		expect(find(result, ID.a).userTurnCount).toBe(1);
	});

	it('de-duplicates a session across folders and formats, keeping the later update', async () => {
		const path = '/work/dup';
		const root = makeRoot({
			'projects.json': JSON.stringify({ projects: { [path]: 'dup' } }),
			'tmp/dup/.project_root': path,
			'tmp/dup/chats/session-2026-05-01T10-00-aaaaaaaa.jsonl': jsonl(
				meta(ID.a, { lastUpdated: '2026-05-02T00:00:00.000Z', summary: 'Newer' }),
				userMsg('m1')
			),
			[`tmp/${sha(path)}/chats/session-2026-05-01T10-00-aaaaaaaa.json`]: JSON.stringify({
				...meta(ID.a, { lastUpdated: '2026-05-01T00:00:00.000Z', summary: 'Older' }),
				messages: [userMsg('m1')]
			})
		});
		const result = await scan(root);
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0]!.session).toMatchObject({ title: 'Newer', projectPath: path });
	});

	it('tolerates malformed and truncated lines, falls back to file mtime, and skips bad IDs', async () => {
		const file = 'tmp/m/chats/session-2026-05-01T10-00-aaaaaaaa.jsonl';
		const root = makeRoot({
			'tmp/m/.project_root': '/work/m',
			[file]:
				JSON.stringify({ sessionId: ID.a, projectHash: 'h' }) +
				'\n{not json\n' +
				JSON.stringify(userMsg('m1')) +
				'\n{"id":"m2","type":"gem',
			'tmp/m/chats/session-2026-05-01T11-00-bbbbbbbb.jsonl': jsonl(meta('-bad id'), userMsg('m1')),
			'tmp/m/chats/session-2026-05-01T12-00-cccccccc.jsonl': 'garbage\n'
		});
		utimesSync(join(root, file), new Date('2026-03-03T03:03:03.000Z'), new Date('2026-03-03T03:03:03.000Z'));
		const result = await scan(root);
		expect(result.sessions).toHaveLength(1);
		const a = find(result, ID.a);
		expect(a.startedAt).toBeNull();
		// No lastUpdated: falls back to the last message timestamp.
		expect(a.lastActivitySource).toBe('transcript');
		expect(a.lastActivityAt).toBe('2026-05-01T10:01:00.000Z');
		expect(result.warnings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: 'malformed-records', count: 1 }),
				expect.objectContaining({ code: 'unsupported-schema', count: 2 })
			])
		);
		for (const warning of result.warnings) expect(warning.message).not.toMatch(/not json|garbage/);
	});

	it('uses file mtime when no timestamps exist', async () => {
		const file = 'tmp/t/chats/session-2026-05-01T10-00-aaaaaaaa.jsonl';
		const root = makeRoot({
			[file]: jsonl({ sessionId: ID.a, projectHash: 'h' }, { id: 'm1', type: 'user', content: 'hi' })
		});
		utimesSync(join(root, file), new Date('2026-03-03T03:03:03.000Z'), new Date('2026-03-03T03:03:03.000Z'));
		const a = find(await scan(root), ID.a);
		expect(a).toMatchObject({ lastActivityAt: '2026-03-03T03:03:03.000Z', lastActivitySource: 'file-mtime' });
		expect(a.projectPath).toBeNull();
	});

	it('also scans the seatbelt runtime directory', async () => {
		const root = makeRoot({});
		const seatbelt = join(root, '..', '.cache', '.gemini', 'tmp', 's');
		mkdirSync(join(seatbelt, 'chats'), { recursive: true });
		writeFileSync(join(seatbelt, '.project_root'), '/work/sandboxed');
		writeFileSync(join(seatbelt, 'chats', 'session-2026-05-01T10-00-aaaaaaaa.jsonl'), jsonl(meta(ID.a), userMsg('m1')));
		const adapter = createGeminiAdapter({ root });
		const result = await adapter.scan({ cache: emptyCache });
		expect(find(result, ID.a).projectPath).toBe('/work/sandboxed');
		const messages = await adapter.preview!(result.sessions[0]!.source.path, { limit: 5, maxChars: 100 });
		expect(messages).toHaveLength(1);
	});

	it('reuses cached results for unchanged files', async () => {
		const root = makeRoot({
			'tmp/c/.project_root': '/work/c',
			'tmp/c/chats/session-2026-05-01T10-00-aaaaaaaa.jsonl': jsonl(meta(ID.a), userMsg('m1'))
		});
		const adapter = createGeminiAdapter({ root });
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

describe('Gemini adapter: resume and preview', () => {
	const session = (overrides: Partial<Session> = {}): Session => ({
		id: `gemini:${ID.a}`,
		provider: 'gemini',
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

	it('builds an argv resume command in the project directory', () => {
		const adapter = createGeminiAdapter({ root: join(base, 'x') });
		expect(adapter.resumeCommand(session())).toEqual({
			executable: 'gemini',
			args: ['--resume', ID.a],
			cwd: '/work/alpha'
		});
		expect(adapter.resumeCommand(session({ nativeId: '--yolo' }))).toBeNull();
		expect(adapter.resumeCommand(session({ projectPath: null }))).toBeNull();
	});

	it('previews the latest text, respecting rewinds and stripping injected context', async () => {
		const root = makeRoot({
			'tmp/v/chats/session-2026-05-01T10-00-aaaaaaaa.jsonl': jsonl(
				meta(ID.a),
				userMsg('m1', '<session_context>secret env</session_context>'),
				userMsg('m2', 'first question'),
				geminiMsg('m3', [{ text: 'thinking', thought: true }, { text: 'first answer' }]),
				userMsg('m4', 'abandoned question'),
				geminiMsg('m5', 'abandoned answer'),
				{ $rewindTo: 'm4' },
				userMsg('m6', '/compress'),
				userMsg('m7', 'x'.repeat(500)),
				geminiMsg('m8', '', { toolCalls: [{ id: 't1', name: 'read_file' }] }),
				geminiMsg('m9', 'final answer'),
				{ id: 'm10', type: 'info', timestamp: '2026-05-01T10:09:00.000Z', content: 'info line' }
			)
		});
		const adapter = createGeminiAdapter({ root });
		const path = join(root, 'tmp/v/chats/session-2026-05-01T10-00-aaaaaaaa.jsonl');
		const messages = await adapter.preview!(path, { limit: 3, maxChars: 50 });
		expect(messages.map((m) => [m.role, m.text.slice(0, 20), m.clipped])).toEqual([
			['assistant', 'first answer', false],
			['user', 'x'.repeat(20), true],
			['assistant', 'final answer', false]
		]);
		expect(messages[1]!.text.length).toBeLessThanOrEqual(51);
		const all = JSON.stringify(await adapter.preview!(path, { limit: 20, maxChars: 50 }));
		expect(all).not.toMatch(/secret env|abandoned|thinking|compress|info line/);
	});

	it('refuses paths outside the store', async () => {
		const adapter = createGeminiAdapter({ root: makeRoot({}) });
		await expect(adapter.preview!('/etc/passwd', { limit: 1, maxChars: 10 })).rejects.toThrow(/outside/);
	});
});
