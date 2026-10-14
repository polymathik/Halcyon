import { readJsonl, type JsonlOptions, type JsonlStats } from '../jsonl.js';

/**
 * Reads a Codex rollout, plain (`.jsonl`) or zstd-compressed (`.jsonl.zst`).
 * Recent Codex releases compress finished rollouts in place; only active or
 * recent ones stay plain.
 *
 * Callers must not log lines or record values: transcripts can contain secrets.
 */
export function readRollout(
	path: string,
	onRecord: (record: Record<string, unknown>) => void,
	options: JsonlOptions = {}
): Promise<JsonlStats> {
	return readJsonl(path, onRecord, path.endsWith('.zst') ? { ...options, decompress: 'zstd' } : options);
}
