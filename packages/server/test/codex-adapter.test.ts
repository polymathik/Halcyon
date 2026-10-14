import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import type { DiscoveredSession, ParseCache, ScanResult } from '@halcyon/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCodexAdapter } from '../src/adapters/codex/codex-adapter.js';

// Synthetic, invented fixtures shaped like Codex rollouts. No real transcripts.
const ID = {
	cli: '0b3c5c8e-6f1a-4d2b-9c3e-1a2b3c4d5e6f',
	cli2: '1c4d6d9f-7a2b-4e3c-8d4f-2b3c4d5e6f70',
	sub: '2d5e7e0a-8b3c-4f4d-9e5a-3c4d5e6f7081',
	ide: '3e6f8f1b-9c4d-4a5e-8f6b-4d5e6f708192',
	stale: '4f7a9a2c-0d5e-4b6f-9a7c-5e6f708192a3',
	other: '5a8bab3d-1e6f-4c7a-8b8d-6f708192a3b4'
};

type Rec = Record<string, unknown>;
let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'halcyon-codex-'));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const at = (minute: number) => `2026-05-01T10:${String(minute).padStart(2, '0')}:00.000Z`;

function meta(id: string, extra: Rec = {}, minute = 0): Rec {
	return {
		timestamp: at(minute),
		type: 'session_meta',
		payload: {
			id,
			session_id: id,
			timestamp: at(minute),
			cwd: '/work/demo-project',
			originator: 'codex_cli_rs',
			cli_version: '0.0.0',
			source: 'cli',
			...extra
		}
	};
}

function user(minute: number, ...texts: string[]): Rec {
	return {
		timestamp: at(minute),
		type: 'response_item',
		payload: { type: 'message', role: 'user', content: texts.map((text) => ({ type: 'input_text', text })) }
	};
}

function item(minute: number, payload: Rec, type = 'response_item'): Rec {
	return { timestamp: at(minute), type, payload };
}

function rolloutPath(id: string, day = '01', suffix = '.jsonl') {
	const dir = join(root, 'sessions', '2026', '05', day);
	mkdirSync(dir, { recursive: true });
	return join(dir, `rollout-2026-05-${day}T10-00-00-${id}${suffix}`);
}

function writeRollout(id: string, records: (Rec | string)[], options: { day?: string; tail?: string } = {}) {
	const path = rolloutPath(id, options.day);
	const body = records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
	writeFileSync(path, body + (options.tail ?? ''));
	return path;
}

function writeIndex(lines: (Rec | string)[]) {
	writeFileSync(
		join(root, 'session_index.jsonl'),
		lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'
	);
}

class MemoryCache implements ParseCache {
	entries = new Map<string, DiscoveredSession & { parserVersion: number }>();
	get(path: string) {
		return this.entries.get(path);
	}
	store(result: ScanResult, parserVersion = 1) {
		for (const d of result.sessions) this.entries.set(d.source.path, { ...d, parserVersion });
	}
}

async function scan(cache: ParseCache = new MemoryCache()) {
	const adapter = createCodexAdapter({ root });
	const result = await adapter.scan({ cache });
	return { adapter, result, byId: new Map(result.sessions.map((d) => [d.session.nativeId, d.session])) };
}

function warning(result: ScanResult, code: string) {
	return result.warnings.filter((w) => w.code === code).reduce((sum, w) => sum + w.count, 0);
}

describe('codex adapter: availability', () => {
	it('reports an unavailable root with a reason, distinct from an empty store', async () => {
		const missing = await createCodexAdapter({ root: join(root, 'nope') }).detect();
		expect(missing.available).toBe(false);
		if (!missing.available) expect(missing.reason).toMatch(/sessions/);

		mkdirSync(join(root, 'sessions'));
		const adapter = createCodexAdapter({ root });
		expect(await adapter.detect()).toEqual({ available: true, storePath: join(root, 'sessions') });
		const result = await adapter.scan({ cache: new MemoryCache() });
		expect(result).toEqual({ sessions: [], warnings: [], parsedCount: 0 });
	});
});

describe('codex adapter: scope', () => {
	it('keeps top-level CLI sessions and excludes subagents, IDE/desktop and exec sessions', async () => {
		writeRollout(ID.cli, [meta(ID.cli), user(1, 'invented request')]);
		writeRollout(ID.sub, [
			meta(ID.sub, { source: { subagent: { thread_spawn: { depth: 1 } } }, thread_source: 'subagent', parent_thread_id: ID.cli }),
			// Forked subagents embed the parent's meta later; it must not re-include them.
			meta(ID.cli),
			user(2, 'copied parent history')
		]);
		writeRollout(ID.ide, [meta(ID.ide, { source: 'vscode', originator: 'Codex Desktop', thread_source: 'user' })]);
		writeRollout(ID.other, [meta(ID.other, { source: 'exec' })]);
		// Older format without `source`: included when nothing marks it as non-CLI.
		writeRollout(ID.cli2, [meta(ID.cli2, { source: undefined, originator: undefined })], { day: '02' });

		const { adapter, byId } = await scan();
		expect([...byId.keys()].sort()).toEqual([ID.cli, ID.cli2].sort());
		expect(adapter.lastScanStats()?.excluded).toMatchObject({ subagent: 1, 'ide-or-desktop': 1, 'non-interactive': 1 });
	});

	it('excludes guardian reviews and child threads even when source says cli', async () => {
		writeRollout(ID.sub, [meta(ID.sub, { thread_source: 'guardian_review' })]);
		writeRollout(ID.other, [meta(ID.other, { parent_thread_id: ID.cli })]);
		const { byId } = await scan();
		expect(byId.size).toBe(0);
	});
});

describe('codex adapter: session fields', () => {
	it('counts only human user turns and derives paths and times from records', async () => {
		writeRollout(ID.cli, [
			meta(ID.cli),
			user(1, '# AGENTS.md instructions for /work/demo-project\n\n<INSTRUCTIONS>invented</INSTRUCTIONS>'),
			user(1, '<environment_context>\n  <cwd>/work/demo-project</cwd>\n</environment_context>'),
			user(2, 'first invented request'),
			item(2, { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'dev note' }] }),
			item(2, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'reply' }] }),
			item(3, { type: 'reasoning', summary: [] }),
			item(3, { type: 'function_call', name: 'shell', arguments: '{"role":"user"}' }),
			item(3, { type: 'function_call_output', output: '"role":"user" in tool output' }),
			item(4, { cwd: '/work/demo-project/sub' }, 'turn_context'),
			user(5, '<turn_aborted>\ninterrupted\n</turn_aborted>'),
			user(6, '<in-app-browser-context url="x">page</in-app-browser-context>\nsecond invented request'),
			{ timestamp: at(6), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:' }] } },
			item(9, { type: 'token_count' }, 'event_msg')
		]);
		const { byId } = await scan();
		const s = byId.get(ID.cli)!;
		expect(s).toMatchObject({
			id: `codex:${ID.cli}`,
			provider: 'codex',
			projectPath: '/work/demo-project',
			latestPath: '/work/demo-project/sub',
			startedAt: at(0),
			lastActivityAt: at(9),
			lastActivitySource: 'transcript',
			userTurnCount: 3,
			title: null,
			titleSource: null
		});
	});

	it('takes titles from the index only, ignores stale index entries, and tolerates bad index lines', async () => {
		writeRollout(ID.cli, [meta(ID.cli), user(1, 'invented request that must never become a title')]);
		writeRollout(ID.cli2, [meta(ID.cli2), user(2, 'another')]);
		writeIndex([
			{ id: ID.cli, thread_name: 'Indexed title', updated_at: '2026-05-01T09:00:00.000000Z' },
			'{"id": broken',
			{ id: ID.stale, thread_name: 'Stale entry with no rollout', updated_at: '2026-05-01T09:00:00Z' }
		]);
		const { result, byId } = await scan();
		expect(byId.size).toBe(2);
		expect(byId.has(ID.stale)).toBe(false);
		expect(byId.get(ID.cli)).toMatchObject({ title: 'Indexed title', titleSource: 'provider-index' });
		expect(byId.get(ID.cli2)).toMatchObject({ title: null, titleSource: null });
		// Older index time does not override newer transcript activity.
		expect(byId.get(ID.cli)).toMatchObject({ lastActivityAt: at(1), lastActivitySource: 'transcript' });
		expect(warning(result, 'malformed-records')).toBe(1);
	});

	it('prefers a newer index updated_at over the transcript time', async () => {
		writeRollout(ID.cli, [meta(ID.cli), user(1, 'x')]);
		writeIndex([{ id: ID.cli, thread_name: 'T', updated_at: '2026-05-02T08:00:00.123456Z' }]);
		const { byId } = await scan();
		expect(byId.get(ID.cli)).toMatchObject({
			lastActivityAt: '2026-05-02T08:00:00.123Z',
			lastActivitySource: 'provider-index'
		});
	});

	it('survives malformed middle lines and a partial trailing line', async () => {
		writeRollout(ID.cli, [meta(ID.cli), user(1, 'a'), '{"timestamp":"2026-05-01T10:02:00.000Z","type":"turn_context" garbage', user(3, 'b')], {
			tail: '{"timestamp":"2026-05-01T10:04:00.000Z","type":"response_item","payload":{"type":"mess'
		});
		const { result, byId } = await scan();
		// Raw-prefix tracking sees the partial line's timestamp; that write did happen.
		expect(byId.get(ID.cli)).toMatchObject({ userTurnCount: 2, lastActivityAt: at(4) });
		expect(warning(result, 'malformed-records')).toBe(1);
		expect(result.warnings.map((w) => w.message).join(' ')).not.toMatch(/garbage|mess/);
	});

	it('still parses records serialized with an unexpected key order', async () => {
		writeRollout(ID.cli, [
			{ type: 'session_meta', payload: meta(ID.cli).payload, timestamp: at(0) },
			{ payload: { role: 'user', type: 'message', content: [{ type: 'input_text', text: 'x' }] }, type: 'response_item', timestamp: at(7) }
		]);
		const { byId } = await scan();
		expect(byId.get(ID.cli)).toMatchObject({ userTurnCount: 1, lastActivityAt: at(7) });
	});

	it('prefers the meta ID over a different filename UUID and reports the mismatch', async () => {
		const path = rolloutPath(ID.cli);
		writeFileSync(path, JSON.stringify(meta(ID.cli2)) + '\n');
		const { result, byId } = await scan();
		expect([...byId.keys()]).toEqual([ID.cli2]);
		expect(warning(result, 'index-mismatch')).toBe(1);
	});

	it('reports a rollout with no session metadata without failing the scan', async () => {
		writeRollout(ID.other, [user(1, 'orphan')]);
		writeRollout(ID.cli, [meta(ID.cli)]);
		const { result, byId } = await scan();
		expect([...byId.keys()]).toEqual([ID.cli]);
		expect(warning(result, 'unsupported-schema')).toBe(1);
	});

	it('reads zstd-compressed rollouts', async () => {
		const path = rolloutPath(ID.cli, '03', '.jsonl.zst');
		const body = [meta(ID.cli), user(1, 'a'), user(2, '<environment_context>x</environment_context>')]
			.map((r) => JSON.stringify(r))
			.join('\n');
		writeFileSync(path, zstdCompressSync(Buffer.from(body + '\n')));
		writeFileSync(rolloutPath(ID.cli2, '03', '.jsonl.zst'), Buffer.from('not zstd at all'));
		const { result, byId } = await scan();
		expect(byId.get(ID.cli)).toMatchObject({ userTurnCount: 1, lastActivityAt: at(2) });
		expect(warning(result, 'unreadable-file')).toBe(1);
	});

	it('builds the resume command as an argument array, refusing invalid IDs', async () => {
		writeRollout(ID.cli, [meta(ID.cli)]);
		const { adapter, byId } = await scan();
		const session = byId.get(ID.cli)!;
		expect(adapter.resumeCommand(session)).toEqual({
			executable: 'codex',
			args: ['resume', ID.cli],
			cwd: '/work/demo-project'
		});
		expect(adapter.resumeCommand({ ...session, nativeId: `${ID.cli}; rm -rf /` })).toBeNull();
	});
});

describe('codex adapter: caching', () => {
	const canDenyReads = process.getuid?.() !== 0;

	it.runIf(canDenyReads)('reuses unchanged files from the cache without reading them', async () => {
		const path = writeRollout(ID.cli, [meta(ID.cli), user(1, 'x')]);
		const cache = new MemoryCache();
		const first = await scan(cache);
		expect(first.result.parsedCount).toBe(1);
		cache.store(first.result);

		writeIndex([{ id: ID.cli, thread_name: 'Renamed later', updated_at: '2026-06-01T00:00:00Z' }]);
		chmodSync(path, 0o000); // any read attempt now fails
		try {
			const second = await scan(cache);
			expect(second.result.parsedCount).toBe(0);
			expect(second.result.warnings).toEqual([]);
			// Index changes still apply to cached sessions.
			expect(second.byId.get(ID.cli)).toMatchObject({
				userTurnCount: 1,
				title: 'Renamed later',
				lastActivitySource: 'provider-index'
			});
		} finally {
			chmodSync(path, 0o644);
		}
	});

	it('re-parses when the parser version or file changes', async () => {
		const path = writeRollout(ID.cli, [meta(ID.cli), user(1, 'x')]);
		const cache = new MemoryCache();
		const first = await scan(cache);
		cache.store(first.result, 0);
		expect((await scan(cache)).result.parsedCount).toBe(1);

		cache.store(first.result, 1);
		writeFileSync(path, [meta(ID.cli), user(1, 'x'), user(2, 'y')].map((r) => JSON.stringify(r)).join('\n') + '\n');
		const changed = await scan(cache);
		expect(changed.result.parsedCount).toBe(1);
		expect(changed.byId.get(ID.cli)?.userTurnCount).toBe(2);
	});

	it.runIf(canDenyReads)('remembers excluded files within the process instead of re-reading them', async () => {
		const path = writeRollout(ID.sub, [meta(ID.sub, { source: { subagent: 'review' } })]);
		const adapter = createCodexAdapter({ root });
		expect((await adapter.scan({ cache: new MemoryCache() })).parsedCount).toBe(1);
		chmodSync(path, 0o000);
		try {
			const again = await adapter.scan({ cache: new MemoryCache() });
			expect(again.parsedCount).toBe(0);
			expect(again.warnings).toEqual([]);
			expect(adapter.lastScanStats()?.excluded.subagent).toBe(1);
		} finally {
			chmodSync(path, 0o644);
		}
	});

	it('stops when the scan is aborted', async () => {
		writeRollout(ID.cli, [meta(ID.cli)]);
		const controller = new AbortController();
		controller.abort();
		await expect(createCodexAdapter({ root }).scan({ cache: new MemoryCache(), signal: controller.signal })).rejects.toThrow();
	});
});
