import type { LiveResponse, LiveState, ProviderId, Session } from '@halcyon/core';

/** What a card shows: a live state, `closed`, or nothing when the provider can't tell. */
export type CardStatus = LiveState | 'closed';

export const STATUS_LABEL: Record<CardStatus, string> = {
	working: 'Working',
	waiting: 'Needs input',
	idle: 'Idle',
	open: 'Open',
	closed: 'Closed'
};

/** Per-session status from a live response. Sessions of providers without a working signal are left out. */
export function statusMap(sessions: Session[], live: LiveResponse | null): Map<string, CardStatus> {
	const out = new Map<string, CardStatus>();
	if (!live) return out;
	const reporting = new Set<ProviderId>(live.providers.filter((p) => p.state === 'ok').map((p) => p.provider));
	const states = new Map(live.sessions.map((s) => [s.sessionId as string, s.state]));
	for (const s of sessions) {
		if (!reporting.has(s.provider)) continue;
		out.set(s.id, states.get(s.id) ?? 'closed');
	}
	return out;
}

export const isRunning = (status: CardStatus | undefined | null) => !!status && status !== 'closed';
