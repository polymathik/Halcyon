import type { ProviderId, Session, SessionId } from './session.js';
import type { ScanWarning } from './adapter.js';

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

export interface CardPlacement {
	sessionId: SessionId;
	x: number;
	y: number;
	zoneId: number | null;
}

export interface Zone {
	id: number;
	name: string;
	color: string;
	x: number;
	y: number;
	width: number;
	height: number;
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
}

export interface ApiError {
	error: string;
}
