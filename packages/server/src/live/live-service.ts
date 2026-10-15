import type { LiveResponse, ProcessProbe, ProviderAdapter, ProviderLive, SessionId } from '@halcyon/core';
import { isValidNativeId, toSessionId } from '@halcyon/core';

const CACHE_MS = 1_500;
const CHECK_TIMEOUT_MS = 5_000;
/** How often an unknown running session may trigger a rescan. */
const RESCAN_INTERVAL_MS = 10_000;

export interface LiveServiceDeps {
	adapters: ProviderAdapter[];
	probe: ProcessProbe;
	/** Resolves a transcript path to the session discovered from it. */
	sessionForSource(path: string): SessionId | null;
	/** IDs in the current discovery snapshot. */
	knownSessions(): Set<string>;
	/** Starts a background rescan. */
	rescan(): void;
}

/**
 * Collects each provider's live signal. Providers fail independently: one that
 * cannot report leaves its sessions unknown without affecting the others.
 * Results are cached briefly so several open tabs share one check.
 */
export class LiveService {
	private cached: { at: number; value: LiveResponse } | null = null;
	private inflight: Promise<LiveResponse> | null = null;
	private lastRescan = 0;
	/** Running sessions Halcyon has already rescanned for once (some are never shown, e.g. Codex desktop chats). */
	private readonly rescanned = new Set<string>();

	constructor(private readonly deps: LiveServiceDeps) {}

	current(): Promise<LiveResponse> {
		if (this.cached && Date.now() - this.cached.at < CACHE_MS) return Promise.resolve(this.cached.value);
		this.inflight ??= this.check().finally(() => {
			this.inflight = null;
		});
		return this.inflight;
	}

	private async check(): Promise<LiveResponse> {
		const results = await Promise.all(
			this.deps.adapters.map(async (adapter) => ({ adapter, live: await this.checkOne(adapter) }))
		);
		const known = this.deps.knownSessions();
		const response: LiveResponse = { checkedAt: new Date().toISOString(), providers: [], sessions: [] };
		const seen = new Set<string>();
		const pending = new Set<string>();

		for (const { adapter, live } of results) {
			if (!live) continue;
			if (live.state !== 'ok') {
				response.providers.push({
					provider: adapter.provider,
					state: live.state,
					reason: live.state === 'unavailable' ? live.reason : live.message
				});
				continue;
			}
			response.providers.push({ provider: adapter.provider, state: 'ok', detail: live.detail });
			for (const entry of live.entries) {
				let id: SessionId | null = null;
				if (entry.nativeId && isValidNativeId(entry.nativeId, adapter.provider)) {
					const candidate = toSessionId(adapter.provider, entry.nativeId);
					if (known.has(candidate)) id = candidate;
				}
				if (!id && entry.sourcePath) id = this.deps.sessionForSource(entry.sourcePath);
				if (!id && entry.nativeId && isValidNativeId(entry.nativeId, adapter.provider)) {
					// Running but not on the canvas: either just started (a rescan picks it
					// up) or a kind Halcyon never shows. Rescan once per session, never report it.
					const candidate = toSessionId(adapter.provider, entry.nativeId);
					if (!this.rescanned.has(candidate)) pending.add(candidate);
					continue;
				}
				if (!id || seen.has(id)) continue;
				seen.add(id);
				response.sessions.push({ sessionId: id, state: entry.state, since: entry.since });
			}
		}

		if (this.rescanned.size > 10_000) this.rescanned.clear();
		if (pending.size && Date.now() - this.lastRescan > RESCAN_INTERVAL_MS) {
			this.lastRescan = Date.now();
			for (const id of pending) this.rescanned.add(id);
			this.deps.rescan();
		}
		this.cached = { at: Date.now(), value: response };
		return response;
	}

	private async checkOne(adapter: ProviderAdapter): Promise<ProviderLive | null> {
		if (!adapter.live) return null;
		const controller = new AbortController();
		let timer: NodeJS.Timeout | undefined;
		try {
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new Error('timeout'));
				}, CHECK_TIMEOUT_MS);
			});
			return await Promise.race([adapter.live({ probe: this.deps.probe, signal: controller.signal }), timeout]);
		} catch (error) {
			return {
				state: 'error',
				message: controller.signal.aborted ? 'Live check timed out' : 'Live check failed'
			};
		} finally {
			clearTimeout(timer);
		}
	}
}
