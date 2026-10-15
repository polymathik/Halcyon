import { stat } from 'node:fs/promises';
import type { PreviewMessage, PreviewOptions } from '@halcyon/core';
import { readJsonl } from '../jsonl.js';
import { isWrapperOnly, normalizeTime, PREVIEW_TAIL_BYTES, PreviewCollector } from '../preview.js';

/**
 * Qwen Code transcripts, `<runtime>/projects/<sanitized cwd>/chats/<id>.jsonl`:
 * one record per line, `{uuid, parentUuid, sessionId, timestamp, type, subtype?,
 * cwd, message?: {role, parts[]}, systemPayload?}`. Only identity, timing, cwd
 * and title records are read; message text is never retained by the scan.
 */

export interface QwenTranscriptMeta {
	sessionId: string | null;
	firstCwd: string | null;
	lastCwd: string | null;
	startedAtMs: number | null;
	lastActivityAtMs: number | null;
	title: string | null;
	titleSource: 'custom' | 'provider-generated' | null;
	userTurnCount: number;
	recordCount: number;
	/** The first record is a managed-session header (ownership semantics not verified). */
	managed: boolean;
	malformedLines: number;
}

const ms = (value: unknown): number | null => {
	if (typeof value !== 'string') return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
};

export async function parseQwenTranscript(path: string, signal?: AbortSignal): Promise<QwenTranscriptMeta> {
	const meta: QwenTranscriptMeta = {
		sessionId: null,
		firstCwd: null,
		lastCwd: null,
		startedAtMs: null,
		lastActivityAtMs: null,
		title: null,
		titleSource: null,
		userTurnCount: 0,
		recordCount: 0,
		managed: false,
		malformedLines: 0
	};
	const stats = await readJsonl(
		path,
		(record) => {
			meta.recordCount++;
			if (meta.recordCount === 1 && record.subtype === 'managed_session_header_v1') meta.managed = true;
			if (meta.sessionId === null && typeof record.sessionId === 'string') meta.sessionId = record.sessionId;
			if (typeof record.cwd === 'string' && record.cwd !== '') {
				meta.firstCwd ??= record.cwd;
				meta.lastCwd = record.cwd;
			}
			const at = ms(record.timestamp);
			if (at !== null) {
				meta.startedAtMs ??= at;
				meta.lastActivityAtMs = at;
			}
			if (record.type === 'user' && record.subtype == null) meta.userTurnCount++;
			if (record.type === 'system' && record.subtype === 'custom_title') {
				const payload = record.systemPayload as { customTitle?: unknown; titleSource?: unknown } | undefined;
				const title = typeof payload?.customTitle === 'string' ? payload.customTitle.trim() : '';
				if (title) {
					meta.title = title;
					meta.titleSource = payload?.titleSource === 'manual' ? 'custom' : 'provider-generated';
				}
			}
		},
		signal ? { signal } : {}
	);
	meta.malformedLines = stats.malformedLines;
	return meta;
}

const accept = (line: string) => line.includes('"type":"user"') || line.includes('"type":"assistant"');
const CONTEXT_ELEMENT = /<(system-reminder|session_context|hook_context|system_context)>[\s\S]*?<\/\1>/g;

function partsText(record: Record<string, unknown>): string | null {
	const message = record.message as { parts?: unknown } | undefined;
	if (!message || !Array.isArray(message.parts)) return null;
	const texts: string[] = [];
	for (const part of message.parts) {
		if (part && typeof part === 'object') {
			const { text, thought } = part as { text?: unknown; thought?: unknown };
			if (typeof text === 'string' && thought !== true) texts.push(text);
		}
	}
	return texts.length ? texts.join('') : null;
}

async function collect(path: string, options: PreviewOptions, start: number): Promise<PreviewCollector> {
	const collector = new PreviewCollector(options);
	await readJsonl(
		path,
		(record) => {
			const at = normalizeTime(record.timestamp);
			if (record.type === 'user' && record.subtype == null) {
				const raw = partsText(record);
				if (!raw || isWrapperOnly(raw)) return;
				const text = raw.replace(CONTEXT_ELEMENT, '').trim();
				if (text) collector.add('user', text, at);
			} else if (record.type === 'assistant') {
				const text = partsText(record);
				if (text) collector.add('assistant', text, at);
			}
		},
		{ accept, start, ...(options.signal ? { signal: options.signal } : {}) }
	);
	return collector;
}

/** Recent human prompts and assistant replies, reading the tail first. */
export async function previewQwenTranscript(path: string, options: PreviewOptions): Promise<PreviewMessage[]> {
	const { size } = await stat(path);
	const tailStart = Math.max(0, size - PREVIEW_TAIL_BYTES);
	let collector = await collect(path, options, tailStart);
	if (tailStart > 0 && collector.count < options.limit) collector = await collect(path, options, 0);
	return collector.messages();
}
