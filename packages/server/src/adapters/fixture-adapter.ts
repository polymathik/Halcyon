import type {
	DiscoveredSession,
	NativeCommand,
	PreviewMessage,
	ProviderAdapter,
	ProviderId,
	Session
} from '@halcyon/core';
import { toSessionId } from '@halcyon/core';

/**
 * An in-memory adapter that serves synthetic sessions. Used for tests and for
 * `halcyon --fixtures`, so the UI can be developed without real transcripts.
 */
const FIXTURE_NAMES: Partial<Record<ProviderId, string>> = {
	claude: 'Claude Code',
	codex: 'Codex CLI',
	cursor: 'Cursor CLI',
	gemini: 'Gemini CLI',
	opencode: 'OpenCode',
	copilot: 'Copilot CLI'
};
const FIXTURE_BINARIES: Partial<Record<ProviderId, string>> = { cursor: 'cursor-agent' };

export function createFixtureAdapter(provider: ProviderId, sessions: Session[]): ProviderAdapter {
	return {
		provider,
		displayName: `${FIXTURE_NAMES[provider] ?? provider} (fixtures)`,
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
		// A realistic command for the demo; `--fixtures` runs with a launcher that never starts processes.
		resumeCommand(session): NativeCommand | null {
			return { executable: FIXTURE_BINARIES[provider] ?? provider, args: ['--resume', session.nativeId], cwd: session.projectPath };
		},
		async preview(sourcePath, { limit }): Promise<PreviewMessage[]> {
			const session = sessions.find((s) => `fixture:${s.id}` === sourcePath);
			if (!session) throw new Error('Unknown fixture transcript');
			return FIXTURE_PREVIEW.slice(-limit).map((message) => ({ ...message, clipped: false, at: session.lastActivityAt }));
		}
	};
}

/** Invented demo conversation shown for every fixture session. */
const FIXTURE_PREVIEW: Omit<PreviewMessage, 'clipped' | 'at'>[] = [
	{ role: 'user', text: 'Pick up where we left off and finish the remaining tests.' },
	{ role: 'assistant', text: 'Done. All 12 tests pass. Two edge cases are still untested: an empty request body and a timeout on retry. Want me to add those?' },
	{ role: 'user', text: 'Yes, add both.' },
	{ role: 'assistant', text: 'Added both cases and they pass. Ready for review.' }
];

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

/** Synthetic demo data. Paths, titles and IDs are invented. */
export function demoFixtureAdapters(): ProviderAdapter[] {
	const P = (name: string) => `/Users/demo/projects/${name}`;
	const s = (
		provider: ProviderId,
		nativeId: string,
		title: string | null,
		project: string,
		startedHours: number,
		activeHours: number,
		turns: number | null
	) =>
		fixtureSession(provider, nativeId, {
			title,
			titleSource: title ? 'provider-generated' : null,
			projectPath: P(project),
			startedAt: hoursAgo(startedHours),
			lastActivityAt: hoursAgo(activeHours),
			lastActivitySource: 'transcript',
			userTurnCount: turns
		});
	const byProvider: Partial<Record<ProviderId, Session[]>> = {
		claude: [
			{ ...s('claude', '11111111-1111-4111-8111-111111111111', 'Refactor auth middleware', 'api-server', 30, 0.05, 14), titleSource: 'custom' },
			s('claude', '22222222-2222-4222-8222-222222222222', 'Fix flaky upload test', 'web-client', 80, 0.2, 6),
			s('claude', '33333333-3333-4333-8333-333333333333', null, 'infra', 200, 190, null),
			s('claude', '66666666-6666-4666-8666-666666666666', 'Offline sync for drafts', 'mobile-app', 26, 3, 22)
		],
		codex: [
			s('codex', '44444444-4444-4444-8444-444444444444', 'Add pagination to search API', 'api-server', 5, 0.2, 3),
			s('codex', '55555555-5555-4555-8555-555555555555', 'Migrate CI to new runners', 'infra', 400, 380, 9)
		],
		cursor: [
			s('cursor', '77777777-7777-4777-8777-777777777777', 'Dark mode for settings screen', 'web-client', 50, 20, 11),
			s('cursor', '88888888-8888-4888-8888-888888888888', 'Rate limiter for public API', 'api-server', 120, 96, 5)
		],
		gemini: [s('gemini', '99999999-9999-4999-8999-999999999999', 'Push notification permissions', 'mobile-app', 70, 44, 8)],
		opencode: [s('opencode', 'ses_0a1b2c3d4e5fDemoSessionAa', 'Terraform state cleanup', 'infra', 300, 150, 4)],
		copilot: [s('copilot', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Accessibility pass on forms', 'web-client', 12, 6, 7)]
	};
	const adapters = Object.entries(byProvider).map(([provider, sessions]) =>
		createFixtureAdapter(provider as ProviderId, sessions!)
	);
	// Demo live state so the status display can be seen without real sessions.
	const live: Partial<Record<ProviderId, ProviderAdapter['live']>> = {
		claude: async () => ({
			state: 'ok',
			detail: 'status',
			entries: [
				{ nativeId: '11111111-1111-4111-8111-111111111111', sourcePath: null, state: 'working', since: hoursAgo(0.05) },
				{ nativeId: '22222222-2222-4222-8222-222222222222', sourcePath: null, state: 'waiting', since: hoursAgo(0.1) },
				{ nativeId: '66666666-6666-4666-8666-666666666666', sourcePath: null, state: 'idle', since: hoursAgo(3) }
			]
		}),
		codex: async () => ({
			state: 'ok',
			detail: 'presence',
			entries: [{ nativeId: '44444444-4444-4444-8444-444444444444', sourcePath: null, state: 'open', since: null }]
		})
	};
	for (const adapter of adapters) {
		const check = live[adapter.provider];
		if (check) adapter.live = check;
	}
	return adapters;
}
