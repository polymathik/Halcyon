import { stat } from 'node:fs/promises';
import type { PreviewMessage, PreviewOptions } from '@halcyon/core';
import { readJsonl, type JsonlStats } from '../jsonl.js';
import { isWrapperOnly, normalizeTime, PREVIEW_TAIL_BYTES, PreviewCollector } from '../preview.js';

/**
 * Metadata from a Copilot CLI `events.jsonl`. Holds no message text except a
 * provider-stored title (`session.title_changed`).
 */
export interface CopilotEventsMetadata {
	startedAt: string | null;
	firstCwd: string | null;
	lastCwd: string | null;
	title: string | null;
	lastEventAt: string | null;
	userTurnCount: number;
	/** `session.start` marks a maintenance session detached from its parent; not user-facing. */
	detached: boolean;
	stats: JsonlStats;
}

// Copilot serializes events with JSON.stringify, so an event's own type
// appears as `"type":"session.start"` etc.; inside string values quotes are
// escaped. Types are re-checked after parsing.
const MARKERS = [
	'"type":"session.start"',
	'"type":"session.resume"',
	'"type":"session.context_changed"',
	'"type":"session.title_changed"',
	'"type":"user.message"'
];
// The top-level `timestamp` of every event, read without parsing the event.
// An unescaped `"timestamp":"` can only be JSON structure, never string content.
const TIMESTAMP = /(?<!\\)"timestamp":"([0-9][0-9T:.+\-Z]{9,40})"/;

const object = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const text = (value: unknown): string | null =>
	typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

function contextCwd(data: Record<string, unknown> | null): string | null {
	return text(object(data?.context)?.cwd);
}

function startTime(value: unknown): string | null {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		const date = new Date(value < 1e11 ? value * 1000 : value);
		return Number.isNaN(date.getTime()) ? null : date.toISOString();
	}
	return normalizeTime(value);
}

/** A human-typed prompt: not injected by a skill/command and not an autopilot continuation. */
export function isHumanMessage(data: Record<string, unknown> | null): boolean {
	if (!data) return false;
	if (data.source !== undefined && data.source !== null) return false;
	return data.isAutopilotContinuation !== true;
}

export async function parseCopilotEvents(path: string, signal?: AbortSignal): Promise<CopilotEventsMetadata> {
	const meta: Omit<CopilotEventsMetadata, 'stats'> = {
		startedAt: null,
		firstCwd: null,
		lastCwd: null,
		title: null,
		lastEventAt: null,
		userTurnCount: 0,
		detached: false
	};
	let lastEventMs = -Infinity;
	const noteTime = (value: unknown) => {
		const iso = normalizeTime(value);
		if (!iso) return;
		const ms = Date.parse(iso);
		if (ms >= lastEventMs) {
			lastEventMs = ms;
			meta.lastEventAt = iso;
		}
	};

	const stats = await readJsonl(
		path,
		(record) => {
			if (record.agentId !== undefined && record.agentId !== null) return; // subagent traffic
			noteTime(record.timestamp);
			const data = object(record.data);
			switch (record.type) {
				case 'session.start': {
					if (data && data.detachedFromSpawningParentSessionId !== undefined && data.detachedFromSpawningParentSessionId !== null) {
						meta.detached = true;
					}
					meta.startedAt ??= startTime(data?.startTime) ?? normalizeTime(record.timestamp);
					const cwd = contextCwd(data);
					if (cwd) {
						meta.firstCwd ??= cwd;
						meta.lastCwd = cwd;
					}
					break;
				}
				case 'session.resume':
				case 'session.context_changed': {
					const cwd = contextCwd(data);
					if (cwd) {
						meta.firstCwd ??= cwd;
						meta.lastCwd = cwd;
					}
					break;
				}
				case 'session.title_changed': {
					const title = text(data?.title);
					if (title) meta.title = title;
					break;
				}
				case 'user.message':
					if (isHumanMessage(data)) meta.userTurnCount++;
					break;
			}
		},
		{
			accept: (line) => {
				for (const marker of MARKERS) if (line.includes(marker)) return true;
				const match = TIMESTAMP.exec(line);
				if (match) noteTime(match[1]);
				return false;
			},
			...(signal ? { signal } : {})
		}
	);
	return { ...meta, stats };
}

const acceptPreview = (line: string) => line.includes('"type":"user.message"') || line.includes('"type":"assistant.message"');

/** Recent human prompts and assistant replies from a Copilot CLI `events.jsonl`. */
export async function previewCopilotEvents(path: string, options: PreviewOptions): Promise<PreviewMessage[]> {
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
			if (record.agentId !== undefined && record.agentId !== null) return;
			const data = object(record.data);
			const at = normalizeTime(record.timestamp);
			if (record.type === 'user.message') {
				if (!isHumanMessage(data)) return;
				const content = text(data?.content);
				if (content && !isWrapperOnly(content)) collector.add('user', content, at);
			} else if (record.type === 'assistant.message') {
				const content = text(data?.content);
				if (content) collector.add('assistant', content, at);
			}
		},
		{ accept: acceptPreview, start, ...(options.signal ? { signal: options.signal } : {}) }
	);
	return collector;
}
