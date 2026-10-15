import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LiveContext, LiveEntry, ProviderLive } from '@halcyon/core';
import { isValidNativeId } from '@halcyon/core';

/** `inuse.<pid>.lock` in a session folder, held while a Copilot CLI process has the session open. */
const IN_USE_LOCK = /^inuse\.(\d{1,10})\.lock$/;
/** A process that started this long after its lock file was written is a reused PID. */
const PID_REUSE_SLACK_MS = 60_000;

/**
 * Open Copilot CLI sessions, from the per-session in-use lock files that a
 * running CLI leaves in `<session-state>/<id>/`. A lock counts only while its
 * PID is running and the process started before the lock was written.
 * Copilot publishes no working/idle status, so entries are `open` only.
 *
 * Unverified against a running CLI: the lock name comes from reading the
 * CLI bundle, not from observing a live session.
 */
export async function copilotLive(stateDirs: string[], context: LiveContext): Promise<ProviderLive> {
	const locks: { nativeId: string; pid: number; mtimeMs: number }[] = [];
	let readable = 0;
	for (const stateDir of stateDirs) {
		let sessions;
		try {
			sessions = await readdir(stateDir, { withFileTypes: true });
			readable++;
		} catch {
			continue;
		}
		for (const session of sessions) {
			context.signal?.throwIfAborted();
			if (!session.isDirectory() || !isValidNativeId(session.name, 'copilot')) continue;
			const dir = join(stateDir, session.name);
			let names: string[];
			try {
				names = await readdir(dir);
			} catch {
				continue;
			}
			for (const name of names) {
				const match = IN_USE_LOCK.exec(name);
				if (!match) continue;
				try {
					const info = await lstat(join(dir, name));
					if (!info.isFile()) continue;
					locks.push({ nativeId: session.name.toLowerCase(), pid: Number(match[1]), mtimeMs: info.mtimeMs });
				} catch {
					// removed while listing
				}
			}
		}
	}
	if (readable === 0) return { state: 'unavailable', reason: 'No GitHub Copilot CLI session store to check' };
	if (locks.length === 0) return { state: 'ok', detail: 'presence', entries: [] };

	const processes = await context.probe.processes();
	if (!processes) return { state: 'unavailable', reason: 'Running processes cannot be listed on this system' };
	const running = new Map(processes.map((p) => [p.pid, p]));

	const entries = new Map<string, LiveEntry>();
	for (const lock of locks) {
		const proc = running.get(lock.pid);
		if (!proc) continue;
		if (proc.startedAtMs !== null && proc.startedAtMs > lock.mtimeMs + PID_REUSE_SLACK_MS) continue;
		entries.set(lock.nativeId, { nativeId: lock.nativeId, sourcePath: null, state: 'open', since: null });
	}
	return { state: 'ok', detail: 'presence', entries: [...entries.values()] };
}
