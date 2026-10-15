import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { LiveContext, LiveEntry, ProviderLive } from '@halcyon/core';
import { isValidNativeId } from '@halcyon/core';

/** `<pid>.json`, or `<pid>-<8 hex>.json` for a process hosting several sessions. */
const REGISTRY_FILE = /^(\d{1,10})(?:-[0-9a-f]{8})?\.json$/;
const MAX_REGISTRY_BYTES = 64 * 1024;
/** A process that started this long after the session it claims is a reused PID. */
const PID_REUSE_SLACK_MS = 60_000;

/** The registry fields Halcyon keeps. The file's `token` (an IPC credential) is never kept. */
interface RegistryEntry {
	sessionId: string;
	startedAtMs: number | null;
}

const finiteMs = (value: unknown): number | null =>
	typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 4e15 ? value : null;

async function readRegistryEntry(path: string, pid: number): Promise<RegistryEntry | null> {
	let handle;
	try {
		handle = await open(path, 'r');
		const info = await handle.stat();
		if (!info.isFile() || info.size > MAX_REGISTRY_BYTES) return null;
		const raw = JSON.parse(await handle.readFile('utf8')) as unknown;
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
		// Pick the needed fields; the rest (including `token`) goes out of scope here.
		const { pid: recordPid, sessionId, startedAt } = raw as Record<string, unknown>;
		if (recordPid !== pid) return null;
		if (typeof sessionId !== 'string' || !isValidNativeId(sessionId, 'qwen')) return null;
		return { sessionId: sessionId.toLowerCase(), startedAtMs: finiteMs(startedAt) };
	} catch {
		return null; // being rewritten, removed, or not JSON
	} finally {
		await handle?.close();
	}
}

/**
 * Presence from Qwen Code's session registry, `<qwen home>/sessions/*.json`,
 * which each running top-level session writes with its PID and session ID.
 * An entry counts only while its process is running and started no later than
 * the session, so leftover files and reused PIDs never show as open. Stale
 * files are left for Qwen Code to clean up.
 */
export async function qwenLive(home: string, context: LiveContext): Promise<ProviderLive> {
	const dir = join(home, 'sessions');
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== 'ENOENT') return { state: 'error', message: 'Qwen Code session registry is not readable' };
		try {
			if ((await stat(home)).isDirectory()) return { state: 'ok', detail: 'presence', entries: [] };
		} catch {
			// no Qwen home
		}
		return { state: 'unavailable', reason: 'Qwen Code is not set up on this system' };
	}

	const files = names.flatMap((name) => {
		const match = REGISTRY_FILE.exec(name);
		return match ? [{ path: join(dir, name), pid: Number(match[1]) }] : [];
	});
	if (files.length === 0) return { state: 'ok', detail: 'presence', entries: [] };

	const processes = await context.probe.processes();
	if (!processes) return { state: 'unavailable', reason: 'Running processes cannot be listed on this system' };
	const running = new Map(processes.map((p) => [p.pid, p]));

	const sessions = new Set<string>();
	for (const file of files) {
		context.signal?.throwIfAborted();
		const proc = running.get(file.pid);
		if (!proc) continue;
		const entry = await readRegistryEntry(file.path, file.pid);
		if (!entry) continue;
		if (
			proc.startedAtMs !== null &&
			entry.startedAtMs !== null &&
			proc.startedAtMs > entry.startedAtMs + PID_REUSE_SLACK_MS
		)
			continue;
		sessions.add(entry.sessionId);
	}

	const entries: LiveEntry[] = [...sessions].map((nativeId) => ({
		nativeId,
		sourcePath: null,
		state: 'open',
		since: null
	}));
	return { state: 'ok', detail: 'presence', entries };
}
