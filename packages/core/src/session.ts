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

export const PROVIDERS = [
	'claude',
	'codex',
	'cursor',
	'gemini',
	'qwen',
	'copilot',
	'opencode',
	'kilo',
	'crush',
	'goose'
] as const;
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

	/**
	 * The branch the provider recorded for this session (Claude Code's
	 * `gitBranch`, Codex's `session_meta.git.branch`). Set by adapters that
	 * store one; absent otherwise.
	 */
	sessionBranch?: string | null;
	/**
	 * The current state of the git repository enclosing `projectPath`, read
	 * from its `.git` files by discovery (not adapters, and never persisted).
	 * `null` when the folder is not inside a repository.
	 */
	git?: GitInfo | null;
}

/** A repository as it is on disk now; nothing here comes from a transcript. */
export interface GitInfo {
	/** Working tree root (the folder holding `.git`). */
	root: string;
	/** Repository name: the last segment of the remote URL, else the root folder name. */
	name: string;
	/** `origin` (or the first remote) with any credentials, query and fragment removed. */
	remoteUrl: string | null;
	/** An https page for the remote when one can be derived from its host and path. */
	webUrl: string | null;
	/** Checked-out branch; for a detached HEAD, the short commit hash. */
	branch: string | null;
	detached: boolean;
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
