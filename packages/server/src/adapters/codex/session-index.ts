import { isValidNativeId } from '@halcyon/core';
import { readJsonl } from '../jsonl.js';
import { normalizeTimestamp } from './parse-rollout.js';

export interface IndexEntry {
	title: string | null;
	updatedAt: string | null;
}

export interface SessionIndex {
	/** True when the file exists but could not be read (a missing file is not a failure). */
	failed: boolean;
	entries: Map<string, IndexEntry>;
	malformedLines: number;
}

/**
 * Reads `session_index.jsonl` (`{id, thread_name, updated_at}` per line). It is
 * only a title/recency hint: entries never create sessions, and it is often
 * stale or incomplete. A missing file is normal; an unreadable one is reported
 * by the caller as a warning. When an ID appears more than once (a rename
 * appends a line), the entry with the newest `updated_at` wins.
 */
export async function loadSessionIndex(path: string, signal?: AbortSignal): Promise<SessionIndex> {
	const entries = new Map<string, IndexEntry>();
	let stats;
	try {
		stats = await readJsonl(
			path,
			(record) => {
				if (!isValidNativeId(record.id)) return;
				const id = record.id.toLowerCase();
				const title =
					typeof record.thread_name === 'string' && record.thread_name.trim() !== ''
						? record.thread_name.trim()
						: null;
				const updatedAt = normalizeTimestamp(record.updated_at);
				const existing = entries.get(id);
				if (existing && (existing.updatedAt ?? '') > (updatedAt ?? '')) return;
				entries.set(id, { title: title ?? existing?.title ?? null, updatedAt });
			},
			signal ? { signal } : {}
		);
	} catch (error) {
		signal?.throwIfAborted();
		const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT';
		return { failed: !missing, entries, malformedLines: 0 };
	}
	return { failed: false, entries, malformedLines: stats.malformedLines + (stats.partialTail ? 1 : 0) };
}
