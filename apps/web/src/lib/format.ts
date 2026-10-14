import type { Session } from '@halcyon/core';

const PROVIDER_LABELS: Record<Session['provider'], string> = {
	claude: 'Claude Code',
	codex: 'Codex'
};

export function providerLabel(provider: Session['provider']): string {
	return PROVIDER_LABELS[provider];
}

export function projectName(path: string | null): string | null {
	if (!path) return null;
	const parts = path.split(/[/\\]/).filter(Boolean);
	return parts.at(-1) ?? path;
}

/** Neutral label used when the provider has no title; never prompt text. */
export function displayTitle(session: Session): string {
	if (session.title) return session.title;
	const project = projectName(session.projectPath);
	return project ? `${providerLabel(session.provider)} session · ${project}` : `${providerLabel(session.provider)} session`;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function relativeTime(iso: string | null, now = Date.now()): string {
	if (!iso) return 'Unknown';
	const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
	const units: [Intl.RelativeTimeFormatUnit, number][] = [
		['year', 31_536_000],
		['month', 2_592_000],
		['week', 604_800],
		['day', 86_400],
		['hour', 3_600],
		['minute', 60]
	];
	for (const [unit, size] of units) {
		if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
	}
	return 'Just now';
}
