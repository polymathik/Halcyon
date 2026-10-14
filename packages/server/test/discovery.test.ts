import type { ProviderAdapter } from '@halcyon/core';
import { describe, expect, it } from 'vitest';
import { createFixtureAdapter, fixtureSession } from '../src/adapters/fixture-adapter.js';
import { SessionCacheStore } from '../src/db/session-cache.js';
import { DiscoveryService } from '../src/discovery/discovery-service.js';
import { ids, memoryDb } from './helpers.js';

function adapter(overrides: Partial<ProviderAdapter> & Pick<ProviderAdapter, 'provider'>): ProviderAdapter {
	return { ...createFixtureAdapter(overrides.provider, []), ...overrides };
}

function service(adapters: ProviderAdapter[], db = memoryDb(), scanTimeoutMs?: number) {
	return new DiscoveryService(adapters, new SessionCacheStore(db), scanTimeoutMs ? { scanTimeoutMs } : {});
}

describe('discovery', () => {
	it('isolates a failing adapter from a healthy one', async () => {
		const claude = createFixtureAdapter('claude', [fixtureSession('claude', ids.a)]);
		const codex = adapter({
			provider: 'codex',
			scan: async () => {
				throw new Error('rollout directory unreadable');
			}
		});

		const result = await service([claude, codex]).refresh();

		expect(result.sessions.map((s) => s.id)).toEqual([`claude:${ids.a}`]);
		expect(result.providers.map((p) => [p.provider, p.health.state])).toEqual([
			['claude', 'ok'],
			['codex', 'error']
		]);
	});

	it('distinguishes an unavailable provider from one with no sessions', async () => {
		const claude = createFixtureAdapter('claude', []);
		const codex = adapter({
			provider: 'codex',
			detect: async () => ({ available: false, reason: 'No Codex session store found' })
		});

		const { providers } = await service([claude, codex]).refresh();

		expect(providers[0]?.health).toMatchObject({ state: 'ok', sessionCount: 0 });
		expect(providers[1]?.health).toMatchObject({ state: 'unavailable', reason: 'No Codex session store found' });
	});

	it('times out a hung adapter without blocking others', async () => {
		const hung = adapter({ provider: 'codex', scan: () => new Promise(() => {}) });
		const claude = createFixtureAdapter('claude', [fixtureSession('claude', ids.a)]);

		const result = await service([claude, hung], memoryDb(), 50).refresh();

		expect(result.sessions).toHaveLength(1);
		expect(result.providers[1]?.health).toMatchObject({ state: 'error', message: expect.stringMatching(/timed out/) });
	});

	it('keeps last known sessions when a later scan fails', async () => {
		const db = memoryDb();
		let fail = false;
		const sessions = [fixtureSession('codex', ids.b)];
		const flaky = adapter({
			provider: 'codex',
			scan: async () => {
				if (fail) throw new Error('parse failure');
				return createFixtureAdapter('codex', sessions).scan({ cache: { get: () => undefined } });
			}
		});
		const discovery = service([flaky], db);
		await discovery.refresh();
		fail = true;

		const result = await discovery.refresh();

		expect(result.providers[0]?.health.state).toBe('error');
		expect(result.sessions.map((s) => s.id)).toEqual([`codex:${ids.b}`]);
	});

	it('rejects sessions an adapter reports for another provider', async () => {
		const confused = createFixtureAdapter('claude', [fixtureSession('codex', ids.c)]);
		const result = await service([confused]).refresh();
		expect(result.sessions).toEqual([]);
		expect(result.providers[0]?.health.state).toBe('error');
	});

	it('shares one scan between concurrent refreshes', async () => {
		let scans = 0;
		const counted = adapter({
			provider: 'claude',
			scan: async () => {
				scans++;
				return { sessions: [], warnings: [], parsedCount: 0 };
			}
		});
		const discovery = service([counted]);
		await Promise.all([discovery.refresh(), discovery.refresh(), discovery.current()]);
		expect(scans).toBe(1);
	});
});
