import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse } from 'node:path';

const MAX_LEVELS = 8;

/**
 * Finds the git repository that encloses a session's folder, so sessions
 * started in `repo/web` and `repo/api` group as one project. Looks for a
 * `.git` entry (directory or worktree file) at most eight levels up, never
 * above the home directory or the filesystem root. Falls back to the folder
 * itself. Results are cached per path for the life of the process.
 */
export class ProjectRootResolver {
	private readonly cache = new Map<string, string>();
	private readonly home = homedir();

	resolve(path: string | null): string | null {
		if (!path) return null;
		const cached = this.cache.get(path);
		if (cached !== undefined) return cached;
		const root = this.find(path) ?? path;
		this.cache.set(path, root);
		return root;
	}

	private find(start: string): string | null {
		const { root } = parse(start);
		let dir = start;
		for (let level = 0; level < MAX_LEVELS; level++) {
			if (dir === this.home || dir === root) return null;
			try {
				if (existsSync(join(dir, '.git'))) return dir;
			} catch {
				return null;
			}
			const parent = dirname(dir);
			if (parent === dir) return null;
			dir = parent;
		}
		return null;
	}
}
