import { stat } from 'node:fs/promises';
import type { PreviewMessage, PreviewOptions } from '@halcyon/core';
import { readJsonl, type JsonlStats } from '../jsonl.js';
import { isWrapperOnly, PREVIEW_TAIL_BYTES, PreviewCollector } from '../preview.js';

// Cursor writes records with JSON.stringify, so a record's own role appears as
// `"role":"user"`; inside string values the quotes are escaped. Roles are
// re-checked after parsing.
const acceptUser = (line: string) => line.includes('"role":"user"');
const acceptPreview = (line: string) => line.includes('"role":"user"') || line.includes('"role":"assistant"');

/** Counts the user records in a Cursor agent transcript. Reads no text. */
export async function countCursorUserTurns(
	path: string,
	signal?: AbortSignal
): Promise<{ userTurnCount: number; stats: JsonlStats }> {
	let userTurnCount = 0;
	const stats = await readJsonl(
		path,
		(record) => {
			if (record.role === 'user') userTurnCount++;
		},
		{ accept: acceptUser, ...(signal ? { signal } : {}) }
	);
	return { userTurnCount, stats };
}

const USER_QUERY = /<user_query>([\s\S]*?)<\/user_query>/g;
const INJECTED = /<(timestamp|system_reminder|system-reminder|user_info|additional_data|attached_files)\b[^>]*>[\s\S]*?<\/\1>/g;

/**
 * Reduces a Cursor user record's text to what the user typed: Cursor wraps the
 * prompt in `<user_query>` alongside injected context. Without that tag, known
 * context tags are removed and wrapper-only text is dropped.
 */
export function cursorUserText(raw: string): string | null {
	const queries = [...raw.matchAll(USER_QUERY)].map((m) => m[1]!.trim()).filter((t) => t !== '');
	if (queries.length > 0) return queries.join('\n\n');
	const stripped = raw.replace(INJECTED, '').trim();
	if (stripped === '' || isWrapperOnly(stripped)) return null;
	return stripped;
}

/** Recent user prompts and assistant replies from a Cursor agent transcript (no timestamps). */
export async function previewCursorTranscript(path: string, options: PreviewOptions): Promise<PreviewMessage[]> {
	const { size } = await stat(path);
	const tailStart = Math.max(0, size - PREVIEW_TAIL_BYTES);
	let collector = await collect(path, options, tailStart);
	if (tailStart > 0 && collector.count < options.limit) collector = await collect(path, options, 0);
	return collector.messages();
}

async function collect(path: string, options: PreviewOptions, start: number): Promise<PreviewCollector> {
	const collector = new PreviewCollector(options);
	await readJsonl(
		path,
		(record) => {
			const text = messageText(record);
			if (!text) return;
			if (record.role === 'user') {
				const prompt = cursorUserText(text);
				if (prompt) collector.add('user', prompt, null);
			} else if (record.role === 'assistant') {
				collector.add('assistant', text, null);
			}
		},
		{ accept: acceptPreview, start, ...(options.signal ? { signal: options.signal } : {}) }
	);
	return collector;
}

function messageText(record: Record<string, unknown>): string | null {
	const message = record.message;
	if (!message || typeof message !== 'object') return null;
	const content = (message as { content?: unknown }).content;
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
			const text = (block as { text?: unknown }).text;
			if (typeof text === 'string') parts.push(text);
		}
	}
	return parts.length ? parts.join('\n\n') : null;
}
