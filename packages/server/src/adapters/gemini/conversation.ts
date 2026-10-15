import { readFile } from 'node:fs/promises';
import { readJsonl } from '../jsonl.js';

/**
 * Gemini CLI conversation files (`<runtime>/tmp/<project>/chats/session-*`).
 *
 * Current files are append-only JSONL: a metadata line, message lines, and
 * mutation lines (`$set`, `$rewindTo`, `$patch`). Legacy files are one JSON
 * object with a `messages` array. Both are replayed the way Gemini CLI's own
 * `chatRecordingService` replays them, so rewound or removed messages never
 * count. Message text is only inspected to classify it and is never retained,
 * except by the preview reader (bounded, on request).
 */

/** Largest legacy (whole-JSON) session file Halcyon will load into memory. */
export const MAX_LEGACY_BYTES = 64 * 1024 * 1024;

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj =>
	value !== null && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Text of a Gemini `PartListUnion`: a string, a part, or an array of parts. Non-text parts are ignored. */
export function partsText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) return value.map(partsText).join('');
	if (isObj(value) && typeof value.text === 'string' && value.thought !== true) return value.text;
	return '';
}

/** Gemini CLI's own rule for user messages that are not conversation content. */
export function isIgnoredUserContent(trimmed: string): boolean {
	return (
		trimmed.length === 0 ||
		trimmed.startsWith('/') ||
		trimmed.startsWith('?') ||
		trimmed.startsWith('<session_context>') ||
		trimmed.startsWith('<hook_context>')
	);
}

function isResumable(record: Obj): boolean {
	const text = partsText(record.content).trim();
	if (record.type === 'user') return !isIgnoredUserContent(text);
	if (record.type === 'gemini') {
		return (
			text.length > 0 ||
			(Array.isArray(record.toolCalls) && record.toolCalls.length > 0) ||
			(Array.isArray(record.thoughts) && record.thoughts.length > 0)
		);
	}
	return false;
}

interface Metadata {
	sessionId?: unknown;
	projectHash?: unknown;
	startTime?: unknown;
	lastUpdated?: unknown;
	summary?: unknown;
	kind?: unknown;
}

/**
 * Replays records in order, keeping an ordered list of message IDs and a
 * per-message value derived by `classify`. Mirrors Gemini CLI's metadata-only
 * accumulator: a `$rewindTo` to an unknown ID clears everything, as it does there.
 */
class Replay<T> {
	metadata: Metadata = {};
	readonly ids: string[] = [];
	readonly values = new Map<string, T>();
	lastMessageAt: string | null = null;

	constructor(
		private readonly classify: (record: Obj) => T,
		private readonly patch: (existing: T, record: Obj, content: unknown) => T
	) {}

	private addMessage(record: Obj): void {
		const id = record.id as string;
		if (!this.values.has(id)) this.ids.push(id);
		this.values.set(id, this.classify(record));
		const at = str(record.timestamp);
		if (at) this.lastMessageAt = at;
	}

	private reset(): void {
		this.ids.length = 0;
		this.values.clear();
	}

	private remove(id: string): void {
		const index = this.ids.indexOf(id);
		if (index !== -1) this.ids.splice(index, 1);
		this.values.delete(id);
	}

	private applyPatch(patch: Obj): void {
		const id = str(patch.id);
		if (!id || patch.content === undefined) return;
		const existing = this.values.get(id);
		if (existing === undefined) return;
		this.values.set(id, this.patch(existing, patch, patch.content));
	}

	private addMessages(list: unknown): void {
		if (!Array.isArray(list)) return;
		for (const message of list) {
			if (isObj(message) && typeof message.id === 'string') this.addMessage(message);
		}
	}

	record(record: Obj): void {
		if (typeof record.$rewindTo === 'string') {
			const index = this.ids.indexOf(record.$rewindTo);
			if (index === -1) this.reset();
			else for (const removed of this.ids.splice(index)) this.values.delete(removed);
		} else if (isObj(record.$patch)) {
			const patch = record.$patch;
			this.applyPatch(patch);
			if (Array.isArray(patch.updates)) for (const update of patch.updates) if (isObj(update)) this.applyPatch(update);
			if (Array.isArray(patch.removeIds)) {
				for (const id of patch.removeIds) if (typeof id === 'string') this.remove(id);
			}
			if (Array.isArray(patch.orderIds)) {
				const ordered = patch.orderIds.filter(
					(id, i, all): id is string => typeof id === 'string' && this.values.has(id) && all.indexOf(id) === i
				);
				const orderedSet = new Set(ordered);
				const prefix = this.ids.filter((id) => !orderedSet.has(id));
				this.ids.length = 0;
				this.ids.push(...prefix, ...ordered);
			}
		} else if (typeof record.id === 'string') {
			this.addMessage(record);
		} else if (isObj(record.$set)) {
			const set = record.$set;
			if (Array.isArray(set.messages)) {
				this.reset();
				this.addMessages(set.messages);
			}
			const { messages: _messages, ...rest } = set;
			this.metadata = { ...this.metadata, ...rest };
		} else if (typeof record.sessionId === 'string' && typeof record.projectHash === 'string') {
			const { messages, ...rest } = record;
			this.metadata = { ...this.metadata, ...rest };
			this.addMessages(messages);
		}
	}

	get valid(): boolean {
		return typeof this.metadata.sessionId === 'string' && typeof this.metadata.projectHash === 'string';
	}
}

export interface ConversationMeta {
	sessionId: string;
	summary: string | null;
	kind: string | null;
	startTime: string | null;
	lastUpdated: string | null;
	lastMessageAt: string | null;
	/** Non-ignored user messages, after rewinds and removals. */
	userTurnCount: number;
	/** Whether Gemini CLI's resume list would show the session at all. */
	hasResumableContent: boolean;
	malformedLines: number;
}

interface Kind {
	isUser: boolean;
	resumable: boolean;
}

const classifyKind = (record: Obj): Kind => ({ isUser: record.type === 'user', resumable: isResumable(record) });
const patchKind = (existing: Kind, _record: Obj, content: unknown): Kind => {
	const text = partsText(content).trim();
	if (existing.isUser) return { ...existing, resumable: !isIgnoredUserContent(text) };
	return text.length > 0 ? { ...existing, resumable: true } : existing;
};

async function replayFile<T>(
	path: string,
	replay: Replay<T>,
	signal: AbortSignal | undefined
): Promise<{ replay: Replay<T>; malformedLines: number } | null> {
	if (path.endsWith('.jsonl')) {
		const stats = await readJsonl(path, (record) => replay.record(record), signal ? { signal } : {});
		if (replay.valid) return { replay, malformedLines: stats.malformedLines };
	}
	return null;
}

/** Loads a legacy whole-JSON session (also the fallback for JSONL files without a metadata line). */
async function replayLegacy<T>(path: string, replay: Replay<T>, size: number): Promise<Replay<T> | null> {
	if (size > MAX_LEGACY_BYTES) return null;
	let value: unknown;
	try {
		value = JSON.parse(await readFile(path, 'utf8'));
	} catch {
		return null;
	}
	if (!isObj(value)) return null;
	replay.record(value);
	return replay.valid ? replay : null;
}

/** Parses session metadata, or returns null when the file is not a Gemini conversation. */
export async function parseGeminiConversation(
	path: string,
	size: number,
	signal?: AbortSignal
): Promise<ConversationMeta | null> {
	let malformedLines = 0;
	let replay: Replay<Kind> | null = null;
	const streamed = await replayFile(path, new Replay(classifyKind, patchKind), signal);
	if (streamed) {
		replay = streamed.replay;
		malformedLines = streamed.malformedLines;
	} else {
		replay = await replayLegacy(path, new Replay(classifyKind, patchKind), size);
	}
	if (!replay) return null;

	const kinds = [...replay.values.values()];
	const meta = replay.metadata;
	return {
		sessionId: meta.sessionId as string,
		summary: str(meta.summary)?.trim() || null,
		kind: str(meta.kind),
		startTime: str(meta.startTime),
		lastUpdated: str(meta.lastUpdated),
		lastMessageAt: replay.lastMessageAt,
		userTurnCount: kinds.filter((k) => k.isUser && k.resumable).length,
		hasResumableContent: kinds.some((k) => k.resumable),
		malformedLines
	};
}

export interface PreviewItem {
	role: 'user' | 'assistant' | null;
	text: string;
	at: string | null;
}

/**
 * Replays a conversation keeping only user/gemini text, each clipped to
 * `keepChars` so memory stays bounded. Used only for on-request previews.
 */
export async function replayGeminiText(
	path: string,
	size: number,
	keepChars: number,
	signal?: AbortSignal
): Promise<PreviewItem[]> {
	const clip = (text: string) => (text.length > keepChars ? text.slice(0, keepChars) : text);
	const classify = (record: Obj): PreviewItem => ({
		role: record.type === 'user' ? 'user' : record.type === 'gemini' ? 'assistant' : null,
		text: record.type === 'user' || record.type === 'gemini' ? clip(partsText(record.content)) : '',
		at: str(record.timestamp)
	});
	const patch = (existing: PreviewItem, _record: Obj, content: unknown): PreviewItem =>
		existing.role ? { ...existing, text: clip(partsText(content)) } : existing;

	let replay: Replay<PreviewItem> | null =
		(await replayFile(path, new Replay(classify, patch), signal))?.replay ?? null;
	if (!replay) replay = await replayLegacy(path, new Replay(classify, patch), size);
	if (!replay) return [];
	return replay.ids.map((id) => replay.values.get(id)).filter((item): item is PreviewItem => !!item?.role);
}
