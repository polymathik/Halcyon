import type { ProviderId, Session } from '@halcyon/core';

const PROVIDER_LABELS: Record<ProviderId, string> = {
	claude: 'Claude Code',
	codex: 'Codex',
	cursor: 'Cursor CLI',
	gemini: 'Gemini CLI',
	qwen: 'Qwen Code',
	copilot: 'Copilot CLI',
	opencode: 'OpenCode',
	kilo: 'Kilo Code',
	crush: 'Crush',
	goose: 'Goose'
};

/** Monogram for the design system's provider tile (never a vendor logo). */
const PROVIDER_MONOGRAMS: Record<ProviderId, string> = {
	claude: 'C',
	codex: 'Cx',
	cursor: 'Cu',
	gemini: 'G',
	qwen: 'Qw',
	copilot: 'Cp',
	opencode: 'Oc',
	kilo: 'K',
	crush: 'Cr',
	goose: 'Go'
};

export function providerLabel(provider: ProviderId): string {
	return PROVIDER_LABELS[provider];
}

export function providerMonogram(provider: ProviderId): string {
	return PROVIDER_MONOGRAMS[provider];
}

export function projectName(path: string | null): string | null {
	if (!path) return null;
	const parts = path.split(/[/\\]/).filter(Boolean);
	return parts.at(-1) ?? path;
}

/** Shorten a home-directory path to `~/…` for display. Display only. */
export function displayPath(path: string | null): string | null {
	if (!path) return null;
	return path.replace(/^(\/Users|\/home)\/[^/]+(?=\/|$)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, '~');
}

/**
 * A session folder shown from its repository: `app/web` for `~/code/app/web`
 * inside the `app` repo. Falls back to the `~` path outside a repository.
 */
export function repoPath(session: Session): string | null {
	const path = session.latestPath ?? session.projectPath;
	const git = session.git;
	if (!path || !git) return displayPath(path);
	if (path === git.root) return git.name;
	const sep = git.root.includes('\\') ? '\\' : '/';
	return path.startsWith(git.root + sep) ? `${git.name}${sep}${path.slice(git.root.length + 1)}` : displayPath(path);
}

/** The branch a card shows: what the session recorded, else the folder's branch now. */
export function cardBranch(session: Session): string | null {
	return session.sessionBranch ?? session.git?.branch ?? null;
}

/** Neutral label used when the provider has no title; never prompt text. */
export function displayTitle(session: Session): string {
	if (session.title) return session.title;
	const project = projectName(session.projectPath);
	return project ? `${providerLabel(session.provider)} session · ${project}` : `${providerLabel(session.provider)} session`;
}

/** Compact relative time per the design system: now, 4m, 3h, 2d, 5w, 3mo, 1y. */
export function relativeTime(iso: string | null, now = Date.now()): string {
	if (!iso) return '—';
	const time = new Date(iso).getTime();
	if (Number.isNaN(time)) return '—';
	const seconds = Math.max(0, Math.round((now - time) / 1000));
	const units: [string, number][] = [
		['y', 31_536_000],
		['mo', 2_592_000],
		['w', 604_800],
		['d', 86_400],
		['h', 3_600],
		['m', 60]
	];
	for (const [unit, size] of units) {
		if (seconds >= size) return `${Math.floor(seconds / size)}${unit}`;
	}
	return 'now';
}

/** Full local timestamp for tooltips. */
export function exactTime(iso: string | null): string | undefined {
	if (!iso) return undefined;
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString();
}

export function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}
