import type {
	DiscoveredSession,
	NativeCommand,
	ProviderAdapter,
	ProviderId,
	Session
} from '@halcyon/core';
import { toSessionId } from '@halcyon/core';

/**
 * An in-memory adapter that serves synthetic sessions. Used for tests and for
 * `halcyon --fixtures`, so the UI can be developed without real transcripts.
 */
export function createFixtureAdapter(provider: ProviderId, sessions: Session[]): ProviderAdapter {
	return {
		provider,
		displayName: `${provider === 'claude' ? 'Claude Code' : 'Codex CLI'} (fixtures)`,
		parserVersion: 1,
		async detect() {
			return { available: true, storePath: `fixture:${provider}` };
		},
		async scan() {
			const discovered: DiscoveredSession[] = sessions.map((session) => ({
				session,
				source: { path: `fixture:${session.id}`, sizeBytes: 0, mtimeMs: 0 }
			}));
			return { sessions: discovered, warnings: [], parsedCount: discovered.length };
		},
		resumeCommand(): NativeCommand | null {
			return null;
		}
	};
}

export function fixtureSession(
	provider: ProviderId,
	nativeId: string,
	overrides: Partial<Session> = {}
): Session {
	return {
		id: toSessionId(provider, nativeId),
		provider,
		nativeId,
		title: null,
		titleSource: null,
		projectPath: null,
		latestPath: null,
		startedAt: null,
		lastActivityAt: null,
		lastActivitySource: null,
		userTurnCount: null,
		...overrides
	};
}

function hoursAgo(hours: number): string {
	return new Date(Date.now() - hours * 3_600_000).toISOString();
}

/** Synthetic demo data. Paths and titles are invented. */
export function demoFixtureAdapters(): ProviderAdapter[] {
	const claude = [
		fixtureSession('claude', '11111111-1111-4111-8111-111111111111', {
			title: 'Refactor auth middleware',
			titleSource: 'custom',
			projectPath: '/Users/demo/projects/api-server',
			startedAt: hoursAgo(30),
			lastActivityAt: hoursAgo(2),
			lastActivitySource: 'transcript',
			userTurnCount: 14
		}),
		fixtureSession('claude', '22222222-2222-4222-8222-222222222222', {
			title: 'Fix flaky upload test',
			titleSource: 'provider-generated',
			projectPath: '/Users/demo/projects/web-client',
			startedAt: hoursAgo(80),
			lastActivityAt: hoursAgo(50),
			lastActivitySource: 'transcript',
			userTurnCount: 6
		}),
		fixtureSession('claude', '33333333-3333-4333-8333-333333333333', {
			projectPath: '/Users/demo/projects/infra',
			startedAt: hoursAgo(200),
			lastActivityAt: hoursAgo(190),
			lastActivitySource: 'file-mtime'
		})
	];
	const codex = [
		fixtureSession('codex', '44444444-4444-4444-8444-444444444444', {
			title: 'Add pagination to search API',
			titleSource: 'provider-index',
			projectPath: '/Users/demo/projects/api-server',
			startedAt: hoursAgo(5),
			lastActivityAt: hoursAgo(0.2),
			lastActivitySource: 'transcript',
			userTurnCount: 3
		}),
		fixtureSession('codex', '55555555-5555-4555-8555-555555555555', {
			title: 'Migrate CI to new runners',
			titleSource: 'provider-index',
			projectPath: '/Users/demo/projects/infra',
			startedAt: hoursAgo(400),
			lastActivityAt: hoursAgo(380),
			lastActivitySource: 'provider-index',
			userTurnCount: 9
		})
	];
	return [createFixtureAdapter('claude', claude), createFixtureAdapter('codex', codex)];
}
