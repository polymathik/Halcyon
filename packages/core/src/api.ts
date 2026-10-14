import type { ProviderId, Session, SessionId } from './session.js';
import type { PreviewMessage, ScanWarning } from './adapter.js';

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
	filter: SavedFilter | null;
}

export interface ApiError {
	error: string;
}
