/**
 * Provider-owned session metadata, normalized across providers.
 *
 * Everything here is derived from the provider's own files. User-owned data
 * (tags, card positions, zones) lives in the workspace model and is never
 * mixed into this record, so a rescan can replace it wholesale.
 *
 * No field may contain transcript text. Titles are limited to values the
 * provider itself stores as a title (a user-set name, a provider-generated
 * title, or an index thread name); prompt text is never used as a fallback.
 */

export const PROVIDERS = ['claude', 'codex'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

/** Provider-scoped ID, e.g. `claude:<uuid>` or `codex:<uuid>`. */
export type SessionId = `${ProviderId}:${string}`;

/** Where a title came from; `null` title means the UI shows a neutral label. */
export type TitleSource = 'custom' | 'provider-generated' | 'provider-index';

/** Which evidence produced `lastActivityAt`, kept for debugging stale indexes. */
export type ActivitySource = 'transcript' | 'provider-index' | 'file-mtime';

export interface Session {
	id: SessionId;
	provider: ProviderId;
	/** The provider's own session ID, as passed to its resume command. */
	nativeId: string;

	title: string | null;
	titleSource: TitleSource | null;

	/** Working directory when the session started. */
	projectPath: string | null;
	/** Latest recorded working directory, when it differs from `projectPath`. */
	latestPath: string | null;
	/**
	 * The enclosing git repository root of `projectPath`, when one is found,
	 * otherwise `projectPath`. Set by discovery, not by adapters; used to group
	 * sessions by project.
	 */
	projectRoot?: string | null;

	/** ISO 8601 timestamps. */
	startedAt: string | null;
	lastActivityAt: string | null;
	lastActivitySource: ActivitySource | null;

	/**
	 * Count of human-authored user messages. Tool results, injected context, and
	 * meta records are excluded. `null` means the count is unknown, not zero.
	 */
	userTurnCount: number | null;
}

/**
 * A session's live state, reported only from a signal the provider itself
 * publishes (never inferred from file writes):
 * - `working`, `waiting` (needs input) and `idle` come from Claude Code's own
 *   session registry;
 * - `open` means a live process holds the session but reports no detail
 *   (Codex: the rollout file is open in a running `codex` process).
 * A session with no entry is closed when its provider's signal is available,
 * and unknown otherwise.
 */
export type LiveState = 'working' | 'waiting' | 'idle' | 'open';
