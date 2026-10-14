import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LiveContext, LiveEntry, LiveState, ProviderLive } from '@halcyon/core';
import { isValidNativeId } from '@halcyon/core';

/** `<pid>.json`; Claude Code also keeps `<pid>.<hash>.key` files here, which are never read. */
const REGISTRY_FILE = /^(\d{1,10})\.json$/;
const MAX_REGISTRY_BYTES = 64 * 1024;
/**
 * A process that started this long after the session it claims is a reused
 * PID, not the session's process. `ps` reports start time to the second.
 */
const PID_REUSE_SLACK_MS = 60_000;

/** Claude Code's own status words, as it writes them to the registry. */
const STATUS: Record<string, LiveState> = {
	busy: 'working',
	shell: 'working',
	waiting: 'waiting',
	idle: 'idle'
};

/** The registry fields Halcyon uses. Everything else in the file is ignored. */
interface RegistryEntry {
	pid: number;
	sessionId: string;
	startedAtMs: number | null;
	status: string | null;
	statusUpdatedAtMs: number | null;
}

const finiteMs = (value: unknown): number | null =>
	typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 4e15 ? value : null;

async function readRegistryEntry(path: string, pid: number): Promise<RegistryEntry | null> {
	let handle;
	try {
		handle = await open(path, 'r');
		const info = await handle.stat();
		if (!info.isFile() || info.size > MAX_REGISTRY_BYTES) return null;
		const raw = JSON.parse(await handle.readFile('utf8')) as Record<string, unknown>;
		if (typeof raw !== 'object' || raw === null) return null;
		const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : null;
		if (!sessionId || !isValidNativeId(sessionId)) return null;
		return {
			pid,
			sessionId,
			startedAtMs: finiteMs(raw.startedAt),
			status: typeof raw.status === 'string' ? raw.status : null,
			statusUpdatedAtMs: finiteMs(raw.statusUpdatedAt)
		};
	} catch {
		return null; // being rewritten, removed, or not JSON
	} finally {
		await handle?.close();
	}
}

/**
 * Live state from Claude Code's session registry, `<root>/sessions/<pid>.json`,
 * which each running Claude Code process writes and updates with its session
 * ID and a status word (`busy`, `shell`, `waiting`, `idle`). An entry counts
 * only while its process is running and started no later than the session,
 * so a leftover file or a reused PID never shows as open.
 */
export async function claudeLive(root: string, context: LiveContext): Promise<ProviderLive> {
	const dir = join(root, 'sessions');
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === 'ENOENT'
			? { state: 'unavailable', reason: 'This Claude Code version does not publish live session status' }
			: { state: 'error', message: 'Claude Code session registry is not readable' };
	}

	const files = names.flatMap((name) => {
		const match = REGISTRY_FILE.exec(name);
		return match ? [{ path: join(dir, name), pid: Number(match[1]) }] : [];
	});
	if (files.length === 0) return { state: 'ok', detail: 'status', entries: [] };

	const processes = await context.probe.processes();
	if (!processes) return { state: 'unavailable', reason: 'Running processes cannot be listed on this system' };
	const running = new Map(processes.map((p) => [p.pid, p]));

	const bySession = new Map<string, RegistryEntry>();
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
		const existing = bySession.get(entry.sessionId);
		if (!existing || (entry.statusUpdatedAtMs ?? 0) > (existing.statusUpdatedAtMs ?? 0)) {
			bySession.set(entry.sessionId, entry);
		}
	}

	const entries: LiveEntry[] = [...bySession.values()].map((entry) => ({
		nativeId: entry.sessionId,
		sourcePath: null,
		state: (entry.status && STATUS[entry.status]) || 'open',
		since: entry.statusUpdatedAtMs ? new Date(entry.statusUpdatedAtMs).toISOString() : null
	}));
	return { state: 'ok', detail: 'status', entries };
}
