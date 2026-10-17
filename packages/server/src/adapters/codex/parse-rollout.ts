import { isValidNativeId } from '@halcyon/core';
import { cleanName } from '../../discovery/git-info.js';
import { readRollout } from './rollout-reader.js';

/**
 * Rollout filenames: `rollout-<local timestamp>-<uuid>[_<segment id>].jsonl[.zst]`.
 * The optional `_<segment id>` suffix appears on continuation segments of
 * paginated sessions; the leading UUID is still the session ID.
 */
export const ROLLOUT_FILE =
	/^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f-]+)?\.jsonl(?:\.zst)?$/i;

/** Why a rollout is not shown as a top-level, `codex resume`-able CLI session. */
export type ExclusionReason =
	| 'subagent'
	| 'ide-or-desktop'
	| 'non-interactive'
	| 'other-origin'
	| 'no-session-meta';

export interface RolloutFacts {
	nativeId: string;
	/** The meta ID and the filename UUID were both valid but different. */
	idMismatch: boolean;
	projectPath: string | null;
	latestPath: string | null;
	startedAt: string | null;
	/** Newest record timestamp in the transcript. */
	lastRecordAt: string | null;
	userTurnCount: number;
	/** `session_meta.git.branch`: the branch Codex recorded when the session started. */
	branch: string | null;
}

export type RolloutParse =
	| { kind: 'session'; facts: RolloutFacts; malformedLines: number }
	| { kind: 'excluded'; reason: ExclusionReason; malformedLines: number };

/**
 * Decides whether a rollout is a top-level local CLI session, from the FIRST
 * `session_meta` record only. (Forked subagent rollouts embed a copy of the
 * parent's `session_meta` later in the file; that copy must not be used.)
 *
 * Evidence (Phase 2 inspection of a real store, 128 rollouts):
 * - `source: "cli"` with `originator: "codex_cli_rs"` (no `thread_source`) are
 *   the sessions started from the Codex CLI.
 * - `source: "vscode"` is used by the IDE extension and the Codex desktop app
 *   (`originator` "Codex Desktop" / "codex_work_desktop"), with
 *   `thread_source` "user" or "chatgpt_handoff".
 * - `source: {"subagent": {...}}` (variants `thread_spawn`, `other`) marks
 *   spawned agents and guardian reviews, with `thread_source` "subagent" or
 *   "guardian_review" and usually `parent_thread_id`.
 * - Codex also defines `source: "exec"` (non-interactive `codex exec`) and
 *   `"mcp"`; they are not resumed with `codex resume`.
 *
 * Rule: include only `source === "cli"`, or a missing `source` (older formats)
 * whose originator does not name an IDE/desktop client. In either case the
 * session must not have a `parent_thread_id`, and `thread_source`, when
 * present, must be `"user"`. Missing fields lean towards inclusion because a
 * CLI session that is wrongly shown is less harmful than one that vanishes.
 */
export function classifySessionMeta(payload: Record<string, unknown>): ExclusionReason | null {
	const source = payload.source;
	if (source && typeof source === 'object') {
		return 'subagent' in source ? 'subagent' : 'other-origin';
	}
	if (typeof source === 'string') {
		if (source === 'vscode') return 'ide-or-desktop';
		if (source === 'exec') return 'non-interactive';
		if (source !== 'cli') return 'other-origin';
	} else if (source === undefined || source === null) {
		const originator = payload.originator;
		if (typeof originator === 'string' && /desktop|vscode/i.test(originator)) {
			return 'ide-or-desktop';
		}
	} else {
		return 'other-origin';
	}

	if (typeof payload.parent_thread_id === 'string' && payload.parent_thread_id !== '') return 'subagent';
	const threadSource = payload.thread_source;
	if (typeof threadSource === 'string' && threadSource !== 'user') {
		return threadSource === 'subagent' || threadSource === 'guardian_review' ? 'subagent' : 'other-origin';
	}
	return null;
}

/**
 * A text item that Codex injects into a `role: "user"` message rather than the
 * person typing it. Detected structurally, never by matching prose:
 * - the whole item is a single XML-like element, `<tag ...>...</tag>`
 *   (seen: environment_context, user_instructions, turn_aborted,
 *   recommended_plugins, codex_internal_context, subagent_notification,
 *   send_user_message_question_reply, external_codex_apps_*), or
 * - it starts with the `# AGENTS.md instructions` header Codex uses when it
 *   injects project instructions.
 * A wrapper followed by further text (e.g. `<in-app-browser-context>` and then
 * the request) is not injected-only, so it still counts as a human turn.
 */
const WRAPPED_ELEMENT = /^<([A-Za-z][\w:-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>$/;
const AGENTS_HEADER = '# AGENTS.md instructions';

export function isInjectedOrBlank(item: unknown): boolean {
	if (!item || typeof item !== 'object') return false;
	const { type, text } = item as { type?: unknown; text?: unknown };
	if (type !== 'input_text' || typeof text !== 'string') return false;
	const trimmed = text.trim();
	return trimmed === '' || trimmed.startsWith(AGENTS_HEADER) || WRAPPED_ELEMENT.test(trimmed);
}

/**
 * A human-authored user turn is a `response_item` whose payload is a
 * `message` with `role: "user"` and at least one content item that is not
 * injected context (typed text or an image both count). Developer/system
 * messages, reasoning, tool calls and tool output are other payload types or
 * roles and never count.
 */
export function isHumanUserMessage(payload: Record<string, unknown>): boolean {
	if (payload.type !== 'message' || payload.role !== 'user') return false;
	const content = payload.content;
	if (!Array.isArray(content)) return typeof content === 'string' && content.trim() !== '';
	return content.some((item) => !isInjectedOrBlank(item));
}

/**
 * Records start `{"timestamp":"…",["ordinal":N,]"type":"…"`. Matching that
 * prefix lets the reader track activity time and skip JSON.parse for the bulk
 * of a transcript (tool output, reasoning, token counts). Lines that do not
 * match the layout are parsed and checked structurally instead.
 */
export const RECORD_PREFIX = /^\{"timestamp":"([^"]{1,64})",(?:"ordinal":\d+,)?"type":"([a-z_]{1,64})"/;
const USER_ROLE = '"role":"user"';
const HEAD_WINDOW = 512;

export function normalizeTimestamp(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/**
 * Parses one rollout file into list-view facts. Reading stops right after the
 * first `session_meta` when it shows the session is out of scope, so excluded
 * sessions cost one chunk. Throws only on I/O errors or caller abort.
 */
export async function parseRollout(
	path: string,
	filenameId: string | null,
	signal?: AbortSignal
): Promise<RolloutParse> {
	const stop = new AbortController();
	const combined = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;

	let meta: Record<string, unknown> | null = null;
	let excluded: ExclusionReason | null = null;
	let lastRecordMs = Number.NEGATIVE_INFINITY;
	let projectPath: string | null = null;
	let latestCwd: string | null = null;
	let startedAt: string | null = null;
	let userTurnCount = 0;
	let branch: string | null = null;

	const noteTimestamp = (value: unknown) => {
		if (typeof value !== 'string') return;
		const ms = Date.parse(value);
		if (Number.isFinite(ms) && ms > lastRecordMs) lastRecordMs = ms;
	};

	const accept = (line: string): boolean => {
		if (excluded) return false;
		const match = RECORD_PREFIX.exec(line);
		if (!match) return true;
		noteTimestamp(match[1]);
		const type = match[2];
		if (type === 'session_meta') return meta === null;
		if (type === 'turn_context') return true;
		if (type === 'response_item') return line.slice(0, HEAD_WINDOW).includes(USER_ROLE);
		return false;
	};

	const onRecord = (record: Record<string, unknown>) => {
		if (excluded) return;
		noteTimestamp(record.timestamp);
		const payload = asRecord(record.payload);
		if (!payload) return;
		switch (record.type) {
			case 'session_meta': {
				if (meta) return;
				meta = payload;
				excluded = classifySessionMeta(payload);
				if (excluded) {
					stop.abort();
					return;
				}
				if (typeof payload.cwd === 'string' && payload.cwd !== '') projectPath = payload.cwd;
				startedAt = normalizeTimestamp(payload.timestamp) ?? normalizeTimestamp(record.timestamp);
				branch = cleanName(asRecord(payload.git)?.branch);
				return;
			}
			case 'turn_context': {
				if (typeof payload.cwd === 'string' && payload.cwd !== '') latestCwd = payload.cwd;
				return;
			}
			case 'response_item': {
				if (isHumanUserMessage(payload)) userTurnCount++;
				return;
			}
		}
	};

	let malformedLines = 0;
	try {
		const stats = await readRollout(path, onRecord, { accept, signal: combined });
		malformedLines = stats.malformedLines;
	} catch (error) {
		signal?.throwIfAborted();
		if (!stop.signal.aborted) throw error;
	}

	if (excluded) return { kind: 'excluded', reason: excluded, malformedLines };
	const metaPayload = meta as Record<string, unknown> | null;
	if (!metaPayload) return { kind: 'excluded', reason: 'no-session-meta', malformedLines };

	const metaId = [metaPayload.id, metaPayload.session_id].find((v): v is string => isValidNativeId(v)) ?? null;
	const nativeId = metaId ?? filenameId;
	if (!nativeId) return { kind: 'excluded', reason: 'no-session-meta', malformedLines };

	return {
		kind: 'session',
		malformedLines,
		facts: {
			nativeId: nativeId.toLowerCase(),
			idMismatch: metaId !== null && filenameId !== null && metaId.toLowerCase() !== filenameId.toLowerCase(),
			projectPath,
			latestPath: latestCwd !== null && latestCwd !== projectPath ? latestCwd : null,
			startedAt,
			lastRecordAt: Number.isFinite(lastRecordMs) ? new Date(lastRecordMs).toISOString() : null,
			userTurnCount,
			branch
		}
	};
}
