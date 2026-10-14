import type { ProviderId, Session } from './session.js';

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
}
