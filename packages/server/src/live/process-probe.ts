import { execFile } from 'node:child_process';
import { readdir, readlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ProcessProbe } from '@halcyon/core';

const PS_TIMEOUT_MS = 2_000;
const LSOF_TIMEOUT_MS = 3_000;
const MAX_OUTPUT = 16 * 1024 * 1024;
/** Upper bound on descriptors read per process on Linux. */
const MAX_FDS = 4_096;

interface RunResult {
	stdout: string;
	/** True when the program could not be started at all (not installed). */
	missing: boolean;
}

/**
 * Runs a read-only system tool with an argument array (no shell). A nonzero
 * exit still yields its output: `lsof` exits 1 when one of the listed
 * processes has already gone, which is not a failure here.
 */
function run(executable: string, args: string[], timeout: number): Promise<RunResult> {
	return new Promise((resolve) => {
		execFile(
			executable,
			args,
			{ timeout, maxBuffer: MAX_OUTPUT, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } },
			(error, stdout) => {
				const code = (error as NodeJS.ErrnoException | null)?.code;
				resolve({ stdout: typeof stdout === 'string' ? stdout : '', missing: code === 'ENOENT' });
			}
		);
	});
}

/** `ps` elapsed time, `[[dd-]hh:]mm:ss`, in seconds. */
export function parseElapsed(text: string): number | null {
	const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
	if (!match) return null;
	const [, days, hours, minutes, seconds] = match;
	return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds);
}

/** Parses `ps -A -o pid= -o etime= -o comm=` output. `comm` may contain spaces on macOS. */
export function parsePs(output: string, nowMs: number): { pid: number; name: string; startedAtMs: number | null }[] {
	const out: { pid: number; name: string; startedAtMs: number | null }[] = [];
	for (const line of output.split('\n')) {
		const match = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
		if (!match) continue;
		const elapsed = parseElapsed(match[2]!);
		out.push({
			pid: Number(match[1]),
			name: basename(match[3]!),
			startedAtMs: elapsed === null ? null : nowMs - elapsed * 1000
		});
	}
	return out;
}

/** Names from `lsof -F n` output: one `n<path>` line per open file. */
export function parseLsofNames(output: string): string[] {
	return output
		.split('\n')
		.filter((line) => line.startsWith('n') && line.length > 1)
		.map((line) => line.slice(1));
}

/**
 * The real process probe: `ps` for the process list, `/proc` (Linux) or
 * `lsof` (macOS and other Unix) for open files. Both are read-only and run
 * without a shell. Windows reports nothing, so live state shows as unknown.
 */
export function createProcessProbe(platform: NodeJS.Platform = process.platform): ProcessProbe {
	return {
		async processes() {
			if (platform === 'win32') return null;
			const result = await run('ps', ['-A', '-o', 'pid=', '-o', 'etime=', '-o', 'comm='], PS_TIMEOUT_MS);
			if (result.missing || result.stdout.trim() === '') return null;
			return parsePs(result.stdout, Date.now());
		},

		async openFiles(pids) {
			if (pids.length === 0) return [];
			if (platform === 'win32') return null;
			if (platform === 'linux') {
				const files: string[] = [];
				for (const pid of pids) {
					const dir = join('/proc', String(pid), 'fd');
					let fds: string[];
					try {
						fds = (await readdir(dir)).slice(0, MAX_FDS);
					} catch {
						continue; // gone, or not ours to read
					}
					for (const fd of fds) {
						try {
							files.push(await readlink(join(dir, fd)));
						} catch {
							// closed while we looked
						}
					}
				}
				return files;
			}
			const result = await run('lsof', ['-w', '-n', '-P', '-F', 'n', '-p', pids.join(',')], LSOF_TIMEOUT_MS);
			if (result.missing) return null;
			return parseLsofNames(result.stdout);
		}
	};
}
