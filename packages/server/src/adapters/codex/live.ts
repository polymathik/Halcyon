import { realpath } from 'node:fs/promises';
import { basename, dirname, sep } from 'node:path';
import type { LiveContext, LiveEntry, ProviderLive } from '@halcyon/core';
import { ROLLOUT_FILE } from './parse-rollout.js';

const THREAD_LOCK = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/i;
/** The Codex CLI binary; npm installs launch it from a Node wrapper of the same name. */
const CODEX_PROCESS = /^codex(?:$|[-.])/i;

async function canonical(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return path;
	}
}

const inside = (dir: string, path: string) => path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/**
 * Open Codex sessions: a running `codex` process holds its session's rollout
 * file open while it writes it (`JsonlWriter`), and newer versions also hold
 * `<home>/thread-writer-locks/<thread id>.lock`. Either names the session.
 * Codex publishes no working/idle status, so entries are `open` only.
 *
 * A running Codex that holds no session file (it has not started a thread
 * yet, or a version that writes differently) leaves the provider unknown
 * rather than marking every session closed.
 */
export async function codexLive(root: string, context: LiveContext): Promise<ProviderLive> {
	const processes = await context.probe.processes();
	if (!processes) return { state: 'unavailable', reason: 'Running processes cannot be listed on this system' };
	const pids = processes.filter((p) => CODEX_PROCESS.test(p.name)).map((p) => p.pid);
	if (pids.length === 0) return { state: 'ok', detail: 'presence', entries: [] };

	const files = await context.probe.openFiles(pids);
	if (!files) return { state: 'unavailable', reason: 'Open files cannot be listed on this system (lsof not found)' };
	context.signal?.throwIfAborted();

	const sessionsDir = await canonical(`${root}${sep}sessions`);
	const locksDir = await canonical(`${root}${sep}thread-writer-locks`);
	const homes = [root, await canonical(root)];
	const entries = new Map<string, LiveEntry>();
	for (const file of files) {
		const name = basename(file);
		const rollout = ROLLOUT_FILE.exec(name);
		if (rollout && (inside(sessionsDir, file) || homes.some((home) => inside(`${home}${sep}sessions`, file)))) {
			const id = rollout[1]!.toLowerCase();
			entries.set(id, { nativeId: id, sourcePath: file, state: 'open', since: null });
			continue;
		}
		const lock = THREAD_LOCK.exec(name);
		if (lock && (dirname(file) === locksDir || homes.some((home) => dirname(file) === `${home}${sep}thread-writer-locks`))) {
			const id = lock[1]!.toLowerCase();
			if (!entries.has(id)) entries.set(id, { nativeId: id, sourcePath: null, state: 'open', since: null });
		}
	}
	if (entries.size === 0) {
		return { state: 'unavailable', reason: 'Codex is running, but its open sessions could not be identified' };
	}
	return { state: 'ok', detail: 'presence', entries: [...entries.values()] };
}
