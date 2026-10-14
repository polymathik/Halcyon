import type { LiveState, ProviderId, Session } from './session.js';

/**
 * Identity of the file a session was parsed from. Adapters use it to skip
 * unchanged transcripts; it never leaves the local server.
 */
export interface SourceFingerprint {
	path: string;
	sizeBytes: number;
	mtimeMs: number;
}

export interface DiscoveredSession {
	session: Session;
	source: SourceFingerprint;
}

/**
 * Previously parsed results, keyed by source path. An adapter should reuse an
 * entry when the fingerprint is unchanged and its parser version matches.
 */
export interface ParseCache {
	get(path: string): (DiscoveredSession & { parserVersion: number }) | undefined;
}

export interface ScanContext {
	cache: ParseCache;
	signal?: AbortSignal;
}

/**
 * Non-fatal problems found during a scan. Messages must describe the problem
 * without quoting record content.
 */
export interface ScanWarning {
	code: 'malformed-records' | 'unreadable-file' | 'unsupported-schema' | 'index-mismatch';
	message: string;
	count: number;
}

export interface ScanResult {
	sessions: DiscoveredSession[];
	warnings: ScanWarning[];
	/** Number of transcripts parsed this scan (the rest came from cache). */
	parsedCount: number;
}

/** Whether a provider's local store can be read at all. */
export type ProviderAvailability =
	| { available: true; storePath: string }
	| { available: false; reason: string };

/**
 * An executable and argument array for a native action. Never a shell string:
 * the server launches it without a shell, and only renders a quoted command
 * for copy/paste.
 */
export interface NativeCommand {
	executable: string;
	args: string[];
	cwd: string | null;
}

/** One message in a bounded, on-request transcript preview. */
export interface PreviewMessage {
	role: 'user' | 'assistant';
	/** Plain text, clipped to the requested length. Never persisted or logged. */
	text: string;
	/** True when `text` was cut to fit `maxChars`. */
	clipped: boolean;
	at: string | null;
}

export interface PreviewOptions {
	/** Most recent messages to return. */
	limit: number;
	/** Maximum characters per message. */
	maxChars: number;
	signal?: AbortSignal;
}

/** One running session, as reported by a provider's live signal. */
export interface LiveEntry {
	/** The provider's own session ID, when the signal names it. */
	nativeId: string | null;
	/** The transcript the session writes to, when the signal names that instead. */
	sourcePath: string | null;
	state: LiveState;
	/** When the provider last changed this state (ISO 8601), if it says. */
	since: string | null;
}

/**
 * What a provider's live signal can tell: `status` reports working / waiting /
 * idle; `presence` only reports that a session is open.
 */
export type LiveDetail = 'status' | 'presence';

export type ProviderLive =
	| { state: 'ok'; detail: LiveDetail; entries: LiveEntry[] }
	| { state: 'unavailable'; reason: string }
	| { state: 'error'; message: string };

/** Process facts the live checks need. Injected so tests never touch real processes. */
export interface ProcessProbe {
	/** Running processes: pid, executable base name, and start time (epoch ms) when known. */
	processes(): Promise<{ pid: number; name: string; startedAtMs: number | null }[] | null>;
	/** Files the given processes hold open, or null when that cannot be listed here. */
	openFiles(pids: number[]): Promise<string[] | null>;
}

export interface LiveContext {
	probe: ProcessProbe;
	signal?: AbortSignal;
}

export interface ProviderAdapter {
	readonly provider: ProviderId;
	readonly displayName: string;
	/** Bump when parsing changes so cached results are re-derived. */
	readonly parserVersion: number;

	detect(): Promise<ProviderAvailability>;
	/** Called only after `detect()` reports the store available. */
	scan(context: ScanContext): Promise<ScanResult>;
	resumeCommand(session: Session): NativeCommand | null;
	/**
	 * The last human-authored and assistant text messages from a transcript the
	 * adapter returned in `scan()`. Read only when the user asks for it; the
	 * result is never cached, persisted or logged. Optional: adapters without it
	 * report the preview as unsupported.
	 */
	preview?(sourcePath: string, options: PreviewOptions): Promise<PreviewMessage[]>;
	/**
	 * Running sessions, from a signal the provider publishes. Reads only
	 * process facts and status metadata, never transcript content. Optional:
	 * without it the provider's sessions show no live state.
	 */
	live?(context: LiveContext): Promise<ProviderLive>;
}
