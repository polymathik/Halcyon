import { stat } from 'node:fs/promises';
import type { PreviewMessage, PreviewOptions } from '@halcyon/core';
import { isWrapperOnly, normalizeTime, PREVIEW_TAIL_BYTES, PreviewCollector } from '../preview.js';
import { isHumanUserMessage, isInjectedOrBlank, RECORD_PREFIX } from './parse-rollout.js';
import { readRollout } from './rollout-reader.js';

const HEAD_WINDOW = 512;

/** Only `response_item` messages are read; reasoning, tool calls and output are skipped unparsed. */
function accept(line: string): boolean {
	const match = RECORD_PREFIX.exec(line);
	if (!match) return true;
	return match[2] === 'response_item' && line.slice(0, HEAD_WINDOW).includes('"type":"message"');
}

/**
 * Recent human prompts and assistant replies from a Codex rollout. Uses
 * `response_item` messages only (the `event_msg` copies would duplicate them).
 * Compressed rollouts cannot be read from an offset, so they stream in full.
 */
export async function previewCodexRollout(path: string, options: PreviewOptions): Promise<PreviewMessage[]> {
	const compressed = path.endsWith('.zst');
	const { size } = await stat(path);
	const tailStart = compressed ? 0 : Math.max(0, size - PREVIEW_TAIL_BYTES);
	let collector = await collect(path, options, tailStart);
	if (tailStart > 0 && collector.count < options.limit) collector = await collect(path, options, 0);
	return collector.messages();
}

async function collect(path: string, options: PreviewOptions, start: number): Promise<PreviewCollector> {
	const collector = new PreviewCollector(options);
	await readRollout(
		path,
		(record) => {
			if (record.type !== 'response_item') return;
			const payload = record.payload;
			if (!payload || typeof payload !== 'object') return;
			const item = payload as Record<string, unknown>;
			if (item.type !== 'message') return;
			const at = normalizeTime(record.timestamp);
			if (item.role === 'user') {
				if (!isHumanUserMessage(item)) return;
				const text = contentText(item.content, 'input_text', true);
				if (text && !isWrapperOnly(text)) collector.add('user', text, at);
			} else if (item.role === 'assistant') {
				const text = contentText(item.content, 'output_text', false);
				if (text) collector.add('assistant', text, at);
			}
		},
		{ accept, start, ...(options.signal ? { signal: options.signal } : {}) }
	);
	return collector;
}

function contentText(content: unknown, type: string, skipInjected: boolean): string | null {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== 'object') continue;
		const { type: itemType, text } = item as { type?: unknown; text?: unknown };
		if (itemType !== type || typeof text !== 'string') continue;
		if (skipInjected && isInjectedOrBlank(item)) continue;
		parts.push(text);
	}
	return parts.length ? parts.join('\n\n') : null;
}
