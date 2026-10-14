import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { createClaudeAdapter } from '../src/adapters/claude/claude-adapter.js';
import { createCodexAdapter } from '../src/adapters/codex/codex-adapter.js';
import { createFixtureAdapter, fixtureSession } from '../src/adapters/fixture-adapter.js';
import { readJsonl } from '../src/adapters/jsonl.js';
import { PREVIEW_TAIL_BYTES, PreviewCollector, isWrapperOnly } from '../src/adapters/preview.js';
import { SessionCacheStore } from '../src/db/session-cache.js';
import { WorkspaceStore } from '../src/db/workspace-store.js';
import { DiscoveryService } from '../src/discovery/discovery-service.js';
import { createApp } from '../src/http/app.js';
import { ids, memoryDb } from './helpers.js';

// Synthetic fixtures only. All text, paths and IDs are invented.
const base = mkdtempSync(join(tmpdir(), 'halcyon-preview-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const jsonl = (...records: object[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
const opts = { limit: 6, maxChars: 40 };

describe('PreviewCollector', () => {
	it('keeps the latest messages, collapses assistant runs, and clips long text', () => {
		const c = new PreviewCollector({ limit: 3, maxChars: 10 });
		c.add('user', 'first', null);
		c.add('assistant', 'thinking out loud', null);
		c.add('assistant', 'final', null);
		c.add('user', '   ', null);
		c.add('user', 'second prompt that is long', null);
		c.add('assistant', 'ok', null);
		const messages = c.messages();
		expect(messages.map((m) => [m.role, m.text, m.clipped])).toEqual([
			['assistant', 'final', false],
			['user', 'second pro…', true],
			['assistant', 'ok', false]
		]);
	});

	it('recognizes wrapper-only text structurally', () => {
		expect(isWrapperOnly('<command-name>/clear</command-name>\n<command-args></command-args>')).toBe(true);
		expect(isWrapperOnly('<context>x</context> then a real request')).toBe(false);
		expect(isWrapperOnly('plain text')).toBe(false);
	});
});

describe('readJsonl start offset', () => {
	it('drops the partial line at the offset and reads the rest', async () => {
		const path = join(base, 'offset.jsonl');
		writeFileSync(path, jsonl({ n: 1 }, { n: 2 }, { n: 3 }));
		const seen: unknown[] = [];
		const stats = await readJsonl(path, (r) => seen.push(r.n), { start: 3 });
		expect(seen).toEqual([2, 3]);
		expect(stats.malformedLines).toBe(0);
	});
});

describe('Claude preview', () => {
	const id = 'aaaaaaaa-1111-4111-8111-111111111111';
	const root = join(base, 'claude');
	const dir = join(root, 'projects', '-work-alpha');
	mkdirSync(dir, { recursive: true });
	const t = (m: number) => `2026-05-01T10:${String(m).padStart(2, '0')}:00.000Z`;
	const user = (m: number, content: unknown, extra: object = {}) => ({ type: 'user', sessionId: id, timestamp: t(m), message: { role: 'user', content }, ...extra });
	const asst = (m: number, content: unknown[], extra: object = {}) => ({ type: 'assistant', sessionId: id, timestamp: t(m), message: { role: 'assistant', content }, ...extra });

	it('returns human prompts and assistant text only', async () => {
		const path = join(dir, `${id}.jsonl`);
		writeFileSync(
			path,
			jsonl(
				{ type: 'custom-title', customTitle: 'x' },
				user(1, 'Add a health check'),
				asst(2, [{ type: 'thinking', thinking: 'hidden' }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
				user(3, [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }]),
				asst(4, [{ type: 'text', text: 'Added /healthz.' }]),
				user(5, 'injected context', { isMeta: true }),
				user(6, 'subagent prompt', { isSidechain: true }),
				user(7, '<command-name>/clear</command-name>'),
				user(8, [{ type: 'text', text: 'Now write a test that is much longer than forty characters' }])
			)
		);
		const messages = await createClaudeAdapter({ root }).preview!(path, opts);
		expect(messages.map((m) => [m.role, m.text])).toEqual([
			['user', 'Add a health check'],
			['assistant', 'Added /healthz.'],
			['user', 'Now write a test that is much longer tha…']
		]);
		expect(messages[2]?.clipped).toBe(true);
		expect(messages[0]?.at).toBe(t(1));
	});

	it('reads the tail of a large transcript and falls back to the full file when needed', async () => {
		const path = join(dir, 'bbbbbbbb-2222-4222-8222-222222222222.jsonl');
		const padding = asst(0, [{ type: 'tool_use', id: 'p', name: 'Bash', input: { blob: 'x'.repeat(PREVIEW_TAIL_BYTES) } }]);
		writeFileSync(path, jsonl(user(1, 'early prompt'), padding, asst(2, [{ type: 'text', text: 'late reply' }])));
		const messages = await createClaudeAdapter({ root }).preview!(path, opts);
		expect(messages.map((m) => m.text)).toEqual(['early prompt', 'late reply']);
	});

	it('refuses paths outside the store', async () => {
		await expect(createClaudeAdapter({ root }).preview!(join(base, 'offset.jsonl'), opts)).rejects.toThrow();
	});
});

describe('Codex preview', () => {
	const root = join(base, 'codex');
	const dir = join(root, 'sessions', '2026', '05', '01');
	mkdirSync(dir, { recursive: true });
	const t = (m: number) => `2026-05-01T10:${String(m).padStart(2, '0')}:00.000Z`;
	const rec = (m: number, type: string, payload: object) => ({ timestamp: t(m), type, payload });
	const msg = (m: number, role: string, type: string, ...texts: string[]) =>
		rec(m, 'response_item', { type: 'message', role, content: texts.map((text) => ({ type, text })) });
	const records = [
		rec(0, 'session_meta', { id: ids.a, cwd: '/work/demo', source: 'cli' }),
		msg(1, 'user', 'input_text', '<environment_context>cwd</environment_context>'),
		msg(1, 'user', 'input_text', '# AGENTS.md instructions for /work/demo', 'Fix the login bug'),
		rec(2, 'response_item', { type: 'reasoning', summary: [] }),
		rec(2, 'response_item', { type: 'function_call', name: 'shell', arguments: '{}' }),
		msg(3, 'assistant', 'output_text', 'Fixed it.'),
		rec(3, 'event_msg', { type: 'agent_message', message: 'Fixed it.' }),
		msg(4, 'developer', 'input_text', 'system rules')
	];
	const expected = [
		['user', 'Fix the login bug'],
		['assistant', 'Fixed it.']
	];

	it('reads plain rollouts', async () => {
		const path = join(dir, `rollout-2026-05-01T10-00-00-${ids.a}.jsonl`);
		writeFileSync(path, jsonl(...records));
		const messages = await createCodexAdapter({ root }).preview!(path, opts);
		expect(messages.map((m) => [m.role, m.text])).toEqual(expected);
	});

	it('reads zstd-compressed rollouts', async () => {
		const path = join(dir, `rollout-2026-05-01T10-00-00-${ids.b}.jsonl.zst`);
		writeFileSync(path, zstdCompressSync(Buffer.from(jsonl(...records))));
		const messages = await createCodexAdapter({ root }).preview!(path, opts);
		expect(messages.map((m) => [m.role, m.text])).toEqual(expected);
	});
});

describe('preview and batch placement API', () => {
	const HOST = '127.0.0.1:4317';
	const ORIGIN = `http://${HOST}`;
	function setup() {
		const db = memoryDb();
		const adapters = [createFixtureAdapter('claude', [fixtureSession('claude', ids.a, { title: 'Fixture' })])];
		const workspaces = new WorkspaceStore(db);
		const app = createApp({
			discovery: new DiscoveryService(adapters, new SessionCacheStore(db)),
			workspaces,
			allowedHosts: [HOST],
			webRoot: null
		});
		const request = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
			app.request(path, { ...init, headers: { host: HOST, ...init.headers } });
		return { request, workspaces };
	}

	it('serves a bounded preview with no-store', async () => {
		const res = await setup().request(`/api/sessions/claude:${ids.a}/preview`);
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		const body = await res.json();
		expect(body.sessionId).toBe(`claude:${ids.a}`);
		expect(body.messages.length).toBeGreaterThan(0);
		expect(body.messages.length).toBeLessThanOrEqual(body.limit);
	});

	it('rejects invalid IDs and reports unknown sessions', async () => {
		const { request } = setup();
		expect((await request('/api/sessions/claude:not-a-uuid/preview')).status).toBe(400);
		expect((await request(`/api/sessions/codex:${ids.b}/preview`)).status).toBe(404);
	});

	it('stores a validated batch of placements', async () => {
		const { request, workspaces } = setup();
		const put = (body: unknown) =>
			request('/api/workspace/placements', {
				method: 'PUT',
				headers: { origin: ORIGIN, 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
		expect((await put({ placements: [{ sessionId: 'claude:bad', x: 1, y: 2 }] })).status).toBe(400);
		expect((await put({ placements: [{ sessionId: `claude:${ids.a}`, x: 'a', y: 2 }] })).status).toBe(400);
		expect(workspaces.get()?.placements).toEqual([]);
		const ok = await put({ placements: [{ sessionId: `claude:${ids.a}`, x: 10, y: 20 }, { sessionId: `codex:${ids.b}`, x: 300, y: 20 }] });
		expect(ok.status).toBe(204);
		expect(workspaces.get()?.placements).toHaveLength(2);
	});
});
