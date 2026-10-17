import type { GitInfo } from '@halcyon/core';
import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { ProjectRootResolver } from './project-root.js';

/** Reads the git state of a session folder; injectable so demo mode can supply its own. */
export interface GitReader {
	read(projectPath: string): Promise<GitInfo | null>;
}

const TTL_MS = 5_000;
const MAX_FILE_BYTES = 256 * 1024;
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Reads `.git/HEAD` and `.git/config` directly; no `git` process is started,
 * so a hostile repository config (hooks, fsmonitor, aliases) never runs.
 * Linked worktrees are followed through their `gitdir:` file and `commondir`.
 * Results are cached per repository for a few seconds so a branch switch
 * shows up on the next poll without re-reading files for every session.
 */
export class FileGitReader implements GitReader {
	private readonly cache = new Map<string, { at: number; value: Promise<GitInfo | null> }>();

	constructor(
		private readonly roots = new ProjectRootResolver(),
		private readonly ttlMs = TTL_MS
	) {}

	async read(projectPath: string): Promise<GitInfo | null> {
		const root = this.roots.repoRoot(projectPath);
		if (!root) return null;
		const hit = this.cache.get(root);
		if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
		const value = readRepository(root).catch(() => null);
		this.cache.set(root, { at: Date.now(), value });
		return value;
	}
}

export async function readRepository(root: string): Promise<GitInfo | null> {
	const gitDir = await locateGitDir(root);
	if (!gitDir) return null;
	const commonDir = await readSmall(join(gitDir, 'commondir'))
		.then((text) => resolveFrom(gitDir, text.trim()))
		.catch(() => gitDir);

	const head = await readSmall(join(gitDir, 'HEAD')).then(parseHead, () => null);
	const config = await readSmall(join(commonDir, 'config')).catch(() => '');
	const remoteUrl = pickRemote(parseRemotes(config));
	return {
		root,
		name: (remoteUrl && repoNameFromUrl(remoteUrl)) || basename(root),
		remoteUrl,
		webUrl: remoteUrl ? webUrlFor(remoteUrl) : null,
		branch: head?.branch ?? null,
		detached: head?.detached ?? false
	};
}

async function locateGitDir(root: string): Promise<string | null> {
	const dotGit = join(root, '.git');
	const info = await stat(dotGit).catch(() => null);
	if (!info) return null;
	if (info.isDirectory()) return dotGit;
	if (!info.isFile()) return null;
	const match = /^gitdir:\s*(.+?)\s*$/m.exec(await readSmall(dotGit).catch(() => ''));
	return match ? resolveFrom(root, match[1]!) : null;
}

const resolveFrom = (base: string, path: string) => (isAbsolute(path) ? path : resolve(base, path));

async function readSmall(path: string): Promise<string> {
	const info = await stat(path);
	if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('not a small file');
	return readFile(path, 'utf8');
}

export function parseHead(text: string): { branch: string | null; detached: boolean } | null {
	const line = text.trim();
	const ref = /^ref:\s*(\S+)$/.exec(line);
	if (ref) {
		const name = ref[1]!.replace(/^refs\/heads\//, '');
		return { branch: cleanName(name), detached: false };
	}
	if (/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(line)) return { branch: line.slice(0, 7).toLowerCase(), detached: true };
	return null;
}

/** A branch name safe to show: bounded length, no control characters. */
export function cleanName(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const name = value.trim();
	if (name === '' || name.length > 200 || CONTROL.test(name)) return null;
	return name;
}

/** `[remote "name"] url = …` pairs, in file order. */
export function parseRemotes(config: string): { name: string; url: string }[] {
	const remotes: { name: string; url: string }[] = [];
	let current: string | null = null;
	for (const raw of config.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
		const section = /^\[\s*([^\s\]"]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
		if (section) {
			current = section[1]!.toLowerCase() === 'remote' && section[2] !== undefined ? section[2] : null;
			continue;
		}
		if (current === null) continue;
		const pair = /^url\s*=\s*(.*)$/i.exec(line);
		if (pair) {
			const url = pair[1]!.replace(/^"(.*)"$/, '$1').trim();
			if (url) remotes.push({ name: current, url });
		}
	}
	return remotes;
}

function pickRemote(remotes: { name: string; url: string }[]): string | null {
	const chosen = remotes.find((remote) => remote.name === 'origin') ?? remotes[0];
	return chosen ? sanitizeRemoteUrl(chosen.url) : null;
}

const SCP_LIKE = /^(?:([^@/\s]+)@)?([^:/\s]+):(?!\/\/)(.+)$/;

/**
 * Removes anything that may be a secret: userinfo on http(s) URLs (tokens are
 * often put there), any password, and query/fragment. SSH user names such as
 * `git@` are kept, since they are part of the address. Returns null for
 * values that are not plausible remote addresses.
 */
export function sanitizeRemoteUrl(raw: string): string | null {
	const value = raw.trim();
	if (value === '' || value.length > 2_000 || CONTROL.test(value)) return null;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			return null;
		}
		const ssh = url.protocol === 'ssh:' || url.protocol === 'git+ssh:';
		url.password = '';
		if (!ssh) url.username = '';
		url.search = '';
		url.hash = '';
		return url.toString();
	}
	const scp = SCP_LIKE.exec(value);
	if (scp && !/^[a-z]$/i.test(scp[2]!)) {
		// `user@host:path`; a password cannot be written in this form, so only drop a stray `:secret` user part.
		const user = scp[1]?.split(':')[0];
		return `${user ? `${user}@` : ''}${scp[2]}:${scp[3]}`;
	}
	// A local path remote (e.g. `../upstream` or `/srv/git/app.git`).
	return value;
}

export function repoNameFromUrl(url: string): string | null {
	const path = url.replace(/[?#].*$/, '').replace(/[/\\]+$/, '');
	const last = path.split(/[/\\:]/).pop() ?? '';
	const name = last.replace(/\.git$/i, '');
	return cleanName(name);
}

/** `git@github.com:o/r.git` → `https://github.com/o/r`; null when the host is not a plausible web host. */
export function webUrlFor(remote: string): string | null {
	let host: string;
	let path: string;
	let origin: string | null = null;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
		let url: URL;
		try {
			url = new URL(remote);
		} catch {
			return null;
		}
		if (!['http:', 'https:', 'ssh:', 'git+ssh:', 'git:'].includes(url.protocol)) return null;
		host = url.hostname;
		path = url.pathname;
		// An http(s) remote is already a web address, port included.
		if (url.protocol === 'https:' || url.protocol === 'http:') origin = `${url.protocol}//${url.host}`;
	} else {
		const scp = SCP_LIKE.exec(remote);
		if (!scp || /^[a-z]$/i.test(scp[2]!)) return null;
		host = scp[2]!;
		path = `/${scp[3]}`;
	}
	if (!host.includes('.') || !/^[a-z0-9.-]+$/i.test(host)) return null;
	path = path.replace(/\/+$/, '').replace(/\.git$/i, '');
	if (path === '' || path === '/') return null;
	try {
		return new URL(`${origin ?? `https://${host}`}${path.startsWith('/') ? path : `/${path}`}`).toString();
	} catch {
		return null;
	}
}
