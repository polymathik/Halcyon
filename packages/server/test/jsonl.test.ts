import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readJsonl } from '../src/adapters/jsonl.js';

const dir = mkdtempSync(join(tmpdir(), 'halcyon-jsonl-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function read(content: string, accept?: (line: string) => boolean) {
	const path = join(dir, `${Math.random()}.jsonl`);
	writeFileSync(path, content);
	const records: Record<string, unknown>[] = [];
	const stats = await readJsonl(path, (r) => records.push(r), accept ? { accept } : {});
	return { records, stats };
}

describe('readJsonl', () => {
	it('parses complete records and counts malformed lines without throwing', async () => {
		const { records, stats } = await read('{"a":1}\nnot json\n[1,2]\n\n{"a":2}\n');
		expect(records).toEqual([{ a: 1 }, { a: 2 }]);
		expect(stats).toMatchObject({ malformedLines: 2, partialTail: false });
	});

	it('treats an unterminated final line as a partial write, not corruption', async () => {
		const { records, stats } = await read('{"a":1}\n{"a":');
		expect(records).toEqual([{ a: 1 }]);
		expect(stats).toMatchObject({ malformedLines: 0, partialTail: true });
	});

	it('accepts a complete final record without a trailing newline', async () => {
		const { records, stats } = await read('{"a":1}\n{"a":2}');
		expect(records).toEqual([{ a: 1 }, { a: 2 }]);
		expect(stats.partialTail).toBe(false);
	});

	it('handles multibyte characters split across chunks', async () => {
		const big = 'é'.repeat(70_000);
		const { records } = await read(`{"t":"${big}"}\n{"t":"ok"}\n`);
		expect(records).toHaveLength(2);
		expect((records[0] as { t: string }).t).toBe(big);
	});

	it('skips parsing lines rejected by the pre-filter', async () => {
		const { records } = await read('{"type":"user"}\n{"type":"tool"}\n', (line) => line.includes('"user"'));
		expect(records).toEqual([{ type: 'user' }]);
	});
});

describe('readJsonl with zstd', () => {
	it('decodes compressed files with the same line semantics', async () => {
		const { zstdCompressSync } = await import('node:zlib');
		const path = join(dir, 'compressed.jsonl.zst');
		writeFileSync(path, zstdCompressSync(Buffer.from('{"a":1}\nbad\n{"a":2}\n{"a":')));
		const records: Record<string, unknown>[] = [];
		const stats = await readJsonl(path, (r) => records.push(r), { decompress: 'zstd' });
		expect(records).toEqual([{ a: 1 }, { a: 2 }]);
		expect(stats).toMatchObject({ malformedLines: 1, partialTail: true });
	});

	it('rejects a corrupt compressed file instead of hanging', async () => {
		const path = join(dir, 'corrupt.jsonl.zst');
		writeFileSync(path, Buffer.from('definitely not zstd'));
		await expect(readJsonl(path, () => {}, { decompress: 'zstd' })).rejects.toThrow();
	});
});
