import { stat } from 'node:fs/promises';
import type { PreviewMessage, PreviewOptions } from '@halcyon/core';
import { readJsonl } from '../jsonl.js';
import { isWrapperOnly, normalizeTime, PREVIEW_TAIL_BYTES, PreviewCollector } from '../preview.js';
import { isHumanTurn } from './transcript.js';

const accept = (line: string) => line.includes('"type":"user"') || line.includes('"type":"assistant"');

/**
 * Recent human prompts and assistant replies from a Claude Code transcript.
 * Reads the last few MB first and falls back to the whole file only when the
 * tail holds fewer messages than requested. Tool calls, tool results,
 * thinking, injected/meta records and subagent (sidechain) traffic are skipped.
 */
export async function previewClaudeTranscript(path: string, options: PreviewOptions): Promise<PreviewMessage[]> {
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
			if (record.isSidechain === true) return;
			const at = normalizeTime(record.timestamp);
			if (record.type === 'user') {
				if (!isHumanTurn(record)) return;
				const text = messageText(record);
				if (text && !isWrapperOnly(text)) collector.add('user', text, at);
			} else if (record.type === 'assistant') {
				const text = messageText(record);
				if (text) collector.add('assistant', text, at);
			}
		},
		{ accept, start, ...(options.signal ? { signal: options.signal } : {}) }
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
