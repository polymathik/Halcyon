import type {
	ProviderAdapter,
	ProviderHealth,
	ProviderStatus,
	Session,
	SessionsResponse
} from '@halcyon/core';
import type { SessionCacheStore } from '../db/session-cache.js';

const DEFAULT_SCAN_TIMEOUT_MS = 30_000;

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

	private async scanAll(): Promise<SessionsResponse> {
		const outcomes = await Promise.all(this.adapters.map((adapter) => this.scanOne(adapter)));
		const sessions = dedupe(outcomes.flatMap((outcome) => outcome.sessions));
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
