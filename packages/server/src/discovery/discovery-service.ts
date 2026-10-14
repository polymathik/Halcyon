import type {
	NativeCommand,
	PreviewMessage,
	ProviderAdapter,
	ProviderHealth,
	ProviderStatus,
	Session,
	SessionsResponse
} from '@halcyon/core';
import type { SessionCacheStore } from '../db/session-cache.js';
import { ProjectRootResolver } from './project-root.js';

const DEFAULT_SCAN_TIMEOUT_MS = 30_000;
const PREVIEW_TIMEOUT_MS = 10_000;

export const PREVIEW_LIMIT = 6;
export const PREVIEW_MAX_CHARS = 1_200;

export type PreviewResult =
	| { kind: 'ok'; messages: PreviewMessage[] }
	| { kind: 'not-found' }
	| { kind: 'unsupported' }
	| { kind: 'error'; message: string };

interface ProviderOutcome {
	status: ProviderStatus;
	sessions: Session[];
}

/**
 * Runs every adapter independently. One adapter throwing, hanging, or finding
 * nothing never hides another adapter's sessions. A failed scan falls back to
 * that provider's last known sessions so the canvas does not empty out.
 */
export class DiscoveryService {
	private snapshot: SessionsResponse | null = null;
	private snapshotAt = 0;
	private inflight: Promise<SessionsResponse> | null = null;
	private readonly roots = new ProjectRootResolver();

	constructor(
		private readonly adapters: ProviderAdapter[],
		private readonly cache: SessionCacheStore,
		private readonly options: { scanTimeoutMs?: number } = {}
	) {}

	/**
	 * Returns the latest snapshot, scanning first if none exists yet. When the
	 * snapshot is older than `maxAgeMs`, it is returned immediately and a
	 * background rescan starts (stale-while-revalidate). Unchanged transcripts
	 * cost only a stat, so frequent polling stays cheap.
	 */
	async current(maxAgeMs = Number.POSITIVE_INFINITY): Promise<SessionsResponse> {
		if (!this.snapshot) return this.refresh();
		if (Date.now() - this.snapshotAt > maxAgeMs) void this.refresh();
		return this.snapshot;
	}

	/** Rescans all providers; concurrent callers share one scan. */
	refresh(): Promise<SessionsResponse> {
		this.inflight ??= this.scanAll().finally(() => {
			this.inflight = null;
		});
		return this.inflight;
	}

	/**
	 * A bounded preview of recent messages, read from the session's transcript
	 * on request. Nothing is cached; errors carry no transcript content.
	 */
	async preview(sessionId: Session['id']): Promise<PreviewResult> {
		if (!this.snapshot) await this.refresh();
		const source = this.cache.source(sessionId);
		if (!source) return { kind: 'not-found' };
		const adapter = this.adapters.find((candidate) => candidate.provider === source.provider);
		if (!adapter) return { kind: 'not-found' };
		if (!adapter.preview) return { kind: 'unsupported' };

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS);
		try {
			const messages = await adapter.preview(source.path, {
				limit: PREVIEW_LIMIT,
				maxChars: PREVIEW_MAX_CHARS,
				signal: controller.signal
			});
			return { kind: 'ok', messages };
		} catch (error) {
			return {
				kind: 'error',
				message: controller.signal.aborted ? 'Preview timed out' : 'Transcript could not be read'
			};
		} finally {
			clearTimeout(timer);
		}
	}

	/** IDs in the latest snapshot (empty before the first scan). */
	knownIds(): Set<string> {
		return new Set(this.snapshot?.sessions.map((session) => session.id) ?? []);
	}

	/** The present session discovered from a transcript path, if any. */
	sessionForSource(path: string): Session['id'] | null {
		const id = this.cache.sessionForSource(path);
		return id && this.snapshot?.sessions.some((session) => session.id === id) ? id : null;
	}

	/** A present session and its provider's resume command (null when unsupported). */
	async session(sessionId: Session['id']): Promise<{ session: Session; command: NativeCommand | null } | null> {
		const snapshot = await this.current();
		const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
		if (!session) return null;
		const adapter = this.adapters.find((candidate) => candidate.provider === session.provider);
		return { session, command: adapter ? adapter.resumeCommand(session) : null };
	}

	private async scanAll(): Promise<SessionsResponse> {
		const outcomes = await Promise.all(this.adapters.map((adapter) => this.scanOne(adapter)));
		const sessions = dedupe(outcomes.flatMap((outcome) => outcome.sessions)).map((session) => ({
			...session,
			projectRoot: this.roots.resolve(session.projectPath)
		}));
		this.snapshot = { sessions, providers: outcomes.map((outcome) => outcome.status) };
		this.snapshotAt = Date.now();
		return this.snapshot;
	}

	private async scanOne(adapter: ProviderAdapter): Promise<ProviderOutcome> {
		const started = performance.now();
		const status = (health: ProviderHealth): ProviderStatus => ({
			provider: adapter.provider,
			displayName: adapter.displayName,
			health
		});
		const controller = new AbortController();
		const timeoutMs = this.options.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
		let timer: NodeJS.Timeout | undefined;

		try {
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new Error(`Scan timed out after ${timeoutMs} ms`));
				}, timeoutMs);
			});
			const availability = await Promise.race([adapter.detect(), timeout]);
			if (!availability.available) {
				return {
					status: status({
						state: 'unavailable',
						reason: availability.reason,
						scannedAt: new Date().toISOString()
					}),
					sessions: []
				};
			}
			const result = await Promise.race([
				adapter.scan({ cache: this.cache.parseCache(adapter.provider), signal: controller.signal }),
				timeout
			]);
			const foreign = result.sessions.filter(({ session }) => session.provider !== adapter.provider);
			if (foreign.length > 0) {
				throw new Error(`Adapter returned ${foreign.length} sessions for another provider`);
			}
			this.cache.replaceProvider(adapter.provider, adapter.parserVersion, result.sessions);
			return {
				status: status({
					state: 'ok',
					sessionCount: result.sessions.length,
					warnings: result.warnings,
					scannedAt: new Date().toISOString(),
					durationMs: Math.round(performance.now() - started)
				}),
				sessions: result.sessions.map(({ session }) => session)
			};
		} catch (error) {
			return {
				status: status({
					state: 'error',
					message: describeError(error),
					scannedAt: new Date().toISOString()
				}),
				sessions: this.cache.lastKnown(adapter.provider)
			};
		} finally {
			clearTimeout(timer);
		}
	}
}

function dedupe(sessions: Session[]): Session[] {
	const byId = new Map<string, Session>();
	for (const session of sessions) {
		const existing = byId.get(session.id);
		// Keep the record with the most recent activity when IDs collide.
		if (!existing || (session.lastActivityAt ?? '') > (existing.lastActivityAt ?? '')) {
			byId.set(session.id, session);
		}
	}
	return [...byId.values()];
}

/** Error text only; never include parsed record content in messages. */
function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return 'Unknown scan failure';
}
