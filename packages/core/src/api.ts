import type { LiveState, ProviderId, Session, SessionId } from './session.js';
import type { LiveDetail, PreviewMessage, ScanWarning } from './adapter.js';

/**
 * Per-provider health. "No sessions found" is `ok` with `sessionCount: 0`,
 * which the UI must keep distinct from `unavailable` and `error`.
 */
export type ProviderHealth =
	| {
			state: 'ok';
			sessionCount: number;
			warnings: ScanWarning[];
			scannedAt: string;
			durationMs: number;
	  }
	| { state: 'unavailable'; reason: string; scannedAt: string }
	| { state: 'error'; message: string; scannedAt: string };

export interface ProviderStatus {
	provider: ProviderId;
	displayName: string;
	health: ProviderHealth;
}

export interface SessionsResponse {
	sessions: Session[];
	providers: ProviderStatus[];
}

/**
 * `GET /api/live`. Lists running sessions only. For a provider whose signal is
 * `ok`, a session missing from `sessions` is closed; otherwise its state is
 * unknown and the UI shows none.
 */
export interface LiveResponse {
	checkedAt: string;
	providers: (
		| { provider: ProviderId; state: 'ok'; detail: LiveDetail }
		| { provider: ProviderId; state: 'unavailable' | 'error'; reason: string }
	)[];
	sessions: { sessionId: SessionId; state: LiveState; since: string | null }[];
}

/** `GET /api/sessions/:id/preview`. Served with `Cache-Control: no-store`. */
export interface SessionPreviewResponse {
	sessionId: SessionId;
	messages: PreviewMessage[];
	/** The message limit that was applied. */
	limit: number;
}

/** `GET /api/sessions/:id/command`: what the native actions can do for a session. */
export interface SessionCommandResponse {
	sessionId: SessionId;
	/** Copyable resume command (`cd <folder> && <exe> <args>`), or null when unsupported. */
	command: string | null;
	canResume: boolean;
	canOpenFolder: boolean;
}

/**
 * `PUT /api/workspace/placements` body: positions for several cards at once.
 * `zoneId` is optional: omitted keeps the current zone, `null` removes it.
 */
export interface PlacementBatch {
	placements: { sessionId: SessionId; x: number; y: number; zoneId?: number | null }[];
}

/** The six design-system zone hues; `slate` is the default for a new zone. */
export const ZONE_COLORS = ['slate', 'sage', 'sky', 'sand', 'rose', 'iris'] as const;
export type ZoneColor = (typeof ZONE_COLORS)[number];

export interface ZoneInput {
	name: string;
	color: ZoneColor;
	x: number;
	y: number;
	width: number;
	height: number;
	/** Project folder this zone collects; new sessions from it join automatically. */
	projectPath?: string | null;
	/** Collapsed to its label; cards hidden. */
	collapsed?: boolean;
}

export const MAX_TITLE_LENGTH = 120;
export const MAX_ARCHIVE_BATCH = 2_000;

/** A filter saved with the workspace. Tags match any; names are normalized. */
export interface SavedFilter {
	tags: string[];
	mode: 'highlight' | 'only';
}

/** `PUT /api/sessions/:id/tags` response: the full tag state after the change. */
export interface TagsResponse {
	tags: Tag[];
	sessionTags: { sessionId: SessionId; tagId: number }[];
}

export const MAX_TAGS_PER_SESSION = 20;
export const MAX_TAG_LENGTH = 40;

/**
 * Normalizes a user-typed tag: trims, drops a leading `#`, lower-cases and
 * turns spaces into hyphens. Returns null when nothing valid remains.
 */
export function normalizeTag(raw: string): string | null {
	const tag = raw
		.trim()
		.replace(/^#+/, '')
		.toLowerCase()
		.replace(/\s+/g, '-');
	if (tag === '' || tag.length > MAX_TAG_LENGTH) return null;
	return /^[\p{L}\p{N}][\p{L}\p{N}._\/+-]*$/u.test(tag) ? tag : null;
}

export interface CardPlacement {
	sessionId: SessionId;
	x: number;
	y: number;
	zoneId: number | null;
}

export interface Zone {
	id: number;
	name: string;
	color: ZoneColor;
	x: number;
	y: number;
	width: number;
	height: number;
	projectPath: string | null;
	collapsed: boolean;
}

export interface Tag {
	id: number;
	name: string;
	color: string | null;
}

export interface Viewport {
	x: number;
	y: number;
	zoom: number;
}

export interface WorkspaceResponse {
	id: string;
	name: string;
	viewport: Viewport | null;
	placements: CardPlacement[];
	zones: Zone[];
	tags: Tag[];
	sessionTags: { sessionId: SessionId; tagId: number }[];
	/** Display names the user gave sessions in Halcyon. */
	titles: { sessionId: SessionId; title: string }[];
	/** Sessions archived in Halcyon (hidden unless "Show archived" is on). */
	archived: SessionId[];
	filter: SavedFilter | null;
}

/** `GET /api/workspaces`: every workspace, the default first. */
export interface WorkspaceSummary {
	id: string;
	name: string;
	createdAt: string;
	cardCount: number;
	zoneCount: number;
	/** The default workspace always exists and cannot be deleted. */
	isDefault: boolean;
}

export const MAX_WORKSPACE_NAME = 60;
export const MAX_WORKSPACES = 50;
/** Largest export file accepted by `POST /api/workspaces/import`. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const WORKSPACE_EXPORT_FORMAT = 'halcyon-workspace';

/**
 * A workspace as a portable file. Layout (zones, card positions, viewport,
 * filter) belongs to the workspace; tags, display names and archive state are
 * shared across workspaces and travel along so a backup is complete. Zone IDs
 * are local to the file. No transcript content, ever.
 */
export interface WorkspaceExport {
	format: typeof WORKSPACE_EXPORT_FORMAT;
	version: 1;
	exportedAt: string;
	name: string;
	viewport: Viewport | null;
	filter: SavedFilter | null;
	zones: (ZoneInput & { ref: number })[];
	placements: { sessionId: SessionId; x: number; y: number; zone: number | null }[];
	tags: { sessionId: SessionId; tags: string[] }[];
	titles: { sessionId: SessionId; title: string }[];
	archived: SessionId[];
}

/** `POST /api/workspaces/import` response. */
export interface WorkspaceImportResult {
	workspace: WorkspaceSummary;
	/** Entries skipped because they were invalid. */
	skipped: number;
}

export interface ApiError {
	error: string;
}
