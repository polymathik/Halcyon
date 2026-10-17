import type { TitleSource } from '@halcyon/core';
import { cleanName } from '../../discovery/git-info.js';
import { readJsonl, type JsonlStats } from '../jsonl.js';

/**
 * Metadata extracted from one Claude Code transcript
 * (`<root>/projects/<encoded-project>/<uuid>.jsonl`). Holds no transcript text
 * except a provider-stored title.
 */
export interface ClaudeTranscriptMetadata {
	/** Distinct `sessionId` values seen on user/assistant records. */
	sessionIds: Set<string>;
	title: string | null;
	titleSource: TitleSource | null;
	firstCwd: string | null;
	lastCwd: string | null;
	/** `gitBranch` on the latest record that has one ("HEAD", a detached checkout, is ignored). */
	lastBranch: string | null;
	startedAtMs: number | null;
	lastActivityAtMs: number | null;
	userTurnCount: number;
	/** User/assistant records seen; zero means the file holds metadata only. */
	conversationRecords: number;
	stats: JsonlStats;
}

// Claude Code serializes records with JSON.stringify (no spaces), so a record's
// own type appears as `"type":"user"` etc. Inside string values the quotes are
// escaped (`\"type\":\"user\"`), so this substring only matches real JSON
// structure. Nested objects can still match; the top-level `type` is re-checked
// after parsing. Skipping attachments, snapshots and other record types avoids
// most JSON.parse work on large transcripts.
const RECORD_MARKERS = [
	'"type":"user"',
	'"type":"assistant"',
	'"type":"custom-title"',
	'"type":"ai-title"'
];

export function acceptClaudeLine(line: string): boolean {
	for (const marker of RECORD_MARKERS) {
		if (line.includes(marker)) return true;
	}
	return false;
}

export async function parseClaudeTranscript(
	path: string,
	signal?: AbortSignal
): Promise<ClaudeTranscriptMetadata> {
	const meta: Omit<ClaudeTranscriptMetadata, 'stats'> = {
		sessionIds: new Set(),
		title: null,
		titleSource: null,
		firstCwd: null,
		lastCwd: null,
		lastBranch: null,
		startedAtMs: null,
		lastActivityAtMs: null,
		userTurnCount: 0,
		conversationRecords: 0
	};
	let customTitle: string | null = null;
	let aiTitle: string | null = null;
	// cwd is taken from the records with the earliest and latest timestamps, so
	// unordered records do not swap the initial and latest directories.
	let firstCwdAt = Infinity;
	let lastCwdAt = -Infinity;
	let untimedFirstCwd: string | null = null;
	let untimedLastCwd: string | null = null;
	let branchAt = -Infinity;
	let untimedBranch: string | null = null;

	const stats = await readJsonl(
		path,
		(record) => {
			switch (record.type) {
				case 'custom-title':
					if (isNonEmptyString(record.customTitle)) customTitle = record.customTitle;
					return;
				case 'ai-title':
					if (isNonEmptyString(record.aiTitle)) aiTitle = record.aiTitle;
					return;
				case 'user':
				case 'assistant':
					break;
				default:
					return;
			}

			meta.conversationRecords++;
			if (isNonEmptyString(record.sessionId)) meta.sessionIds.add(record.sessionId);

			const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
			const hasTime = Number.isFinite(at);
			if (hasTime) {
				if (meta.startedAtMs === null || at < meta.startedAtMs) meta.startedAtMs = at;
				if (meta.lastActivityAtMs === null || at > meta.lastActivityAtMs) meta.lastActivityAtMs = at;
			}

			if (isNonEmptyString(record.cwd)) {
				if (hasTime) {
					if (at < firstCwdAt) [meta.firstCwd, firstCwdAt] = [record.cwd, at];
					if (at >= lastCwdAt) [meta.lastCwd, lastCwdAt] = [record.cwd, at];
				} else {
					// Records without a valid timestamp are a fallback, in file order.
					untimedFirstCwd ??= record.cwd;
					untimedLastCwd = record.cwd;
				}
			}

			const branch = record.gitBranch === 'HEAD' ? null : cleanName(record.gitBranch);
			if (branch !== null) {
				if (!hasTime) untimedBranch = branch;
				else if (at >= branchAt) [meta.lastBranch, branchAt] = [branch, at];
			}

			if (record.type === 'user' && isHumanTurn(record)) meta.userTurnCount++;
		},
		{ accept: acceptClaudeLine, ...(signal ? { signal } : {}) }
	);

	meta.firstCwd ??= untimedFirstCwd;
	meta.lastCwd ??= untimedLastCwd;
	meta.lastBranch ??= untimedBranch;
	if (customTitle !== null) {
		meta.title = customTitle;
		meta.titleSource = 'custom';
	} else if (aiTitle !== null) {
		meta.title = aiTitle;
		meta.titleSource = 'provider-generated';
	}
	return { ...meta, stats };
}

/**
 * Whether a `user` record is a message the human authored.
 *
 * Decided from record structure only; message text is never inspected.
 * Excluded:
 * - `isMeta` records (injected context, skill bodies, command caveats);
 * - `isSidechain` records (subagent traffic);
 * - `isCompactSummary` / `isVisibleInTranscriptOnly` records (compaction
 *   summaries written as user messages);
 * - messages whose content is only `tool_result` blocks (tool output);
 * - records whose `origin.kind` is present and not `human` (for example task
 *   notifications or peer-agent messages), and records whose `promptSource`
 *   is `system` or whose string `turnOrigin` is present and not `human`.
 *
 * Records without any origin marker (older CLI versions, some desktop/SDK
 * entries) are counted. Those include a small number of slash-command and
 * bash-mode wrapper records, so the count may slightly overstate typed prompts
 * on older sessions; telling them apart would require reading message text.
 */
export function isHumanTurn(record: Record<string, unknown>): boolean {
	if (record.isMeta === true || record.isSidechain === true) return false;
	if (record.isCompactSummary === true || record.isVisibleInTranscriptOnly === true) return false;

	const origin = record.origin;
	if (origin && typeof origin === 'object' && 'kind' in origin) {
		if ((origin as { kind: unknown }).kind !== 'human') return false;
	}
	if (record.promptSource === 'system') return false;
	if (typeof record.turnOrigin === 'string' && record.turnOrigin !== 'human') return false;

	const message = record.message;
	if (!message || typeof message !== 'object') return false;
	const content = (message as { content?: unknown }).content;
	if (typeof content === 'string') return true;
	if (Array.isArray(content)) {
		if (content.length === 0) return false;
		return !content.every(
			(block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_result'
		);
	}
	return false;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim() !== '';
}
