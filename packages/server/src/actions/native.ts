import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { NativeCommand } from '@halcyon/core';

/**
 * Native actions: resume a session in a terminal, open its folder, and render
 * a copyable command. Processes are always started from an executable plus an
 * argument array. The only place a shell command line exists is inside the new
 * terminal window, and it is built here with every token quoted.
 */

export type ActionResult = { ok: true } | { ok: false; reason: string };

/** Starts a process without a shell and without waiting for it to exit. */
export interface Launcher {
	launch(executable: string, args: string[], options?: { cwd?: string }): Promise<void>;
	/** Whether an executable can be found on PATH. */
	available(executable: string): Promise<boolean>;
}

export const systemLauncher: Launcher = {
	launch(executable, args, options = {}) {
		return new Promise((resolve, reject) => {
			const child = spawn(executable, args, {
				cwd: options.cwd,
				detached: true,
				stdio: 'ignore',
				shell: false
			});
			child.once('error', reject);
			child.once('spawn', () => {
				child.unref();
				resolve();
			});
		});
	},
	async available(executable) {
		const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
		for (const dir of dirs) {
			try {
				const info = await stat(join(dir, executable));
				if (info.isFile()) return true;
			} catch {
				// Not in this directory.
			}
		}
		return false;
	}
};

/** POSIX single-quote quoting; safe for any string. */
export function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The command a person can paste into a terminal: `cd <dir> && <exe> <args>`. */
export function displayCommand(command: NativeCommand, platform: NodeJS.Platform = process.platform): string {
	const quote = platform === 'win32' ? windowsQuote : shellQuote;
	const run = [command.executable, ...command.args].map(quote).join(' ');
	return command.cwd ? `cd ${quote(command.cwd)} && ${run}` : run;
}

function windowsQuote(value: string): string {
	return /^[A-Za-z0-9_./:=@%+\\-]+$/.test(value) ? value : `"${value.replace(/"/g, '""')}"`;
}

async function isDirectory(path: string | null): Promise<boolean> {
	if (!path) return false;
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/** Linux terminals, in preference order, with the flag that runs a command. */
const LINUX_TERMINALS: [string, string[]][] = [
	['x-terminal-emulator', ['-e']],
	['gnome-terminal', ['--']],
	['konsole', ['-e']],
	['kitty', []],
	['alacritty', ['-e']],
	['xterm', ['-e']]
];

export class NativeActions {
	constructor(
		private readonly launcher: Launcher = systemLauncher,
		private readonly platform: NodeJS.Platform = process.platform
	) {}

	get canResume(): boolean {
		return this.platform === 'darwin' || this.platform === 'linux';
	}

	/**
	 * Opens a new terminal window that changes to the session's folder and runs
	 * the resume command. The folder must still exist: Claude Code keys
	 * sessions to their project directory.
	 */
	async resume(command: NativeCommand): Promise<ActionResult> {
		if (!this.canResume) return { ok: false, reason: 'Resume in terminal is not supported on this system yet. Copy the command instead.' };
		if (command.cwd && !(await isDirectory(command.cwd))) {
			return { ok: false, reason: `The session's folder no longer exists: ${command.cwd}` };
		}
		const line = displayCommand(command, this.platform);
		try {
			if (this.platform === 'darwin') {
				// The command line is passed as an argument, never spliced into the script.
				await this.launcher.launch('osascript', [
					'-e', 'on run argv',
					'-e', 'tell application "Terminal"',
					'-e', 'activate',
					'-e', 'do script (item 1 of argv)',
					'-e', 'end tell',
					'-e', 'end run',
					line
				]);
				return { ok: true };
			}
			for (const [terminal, flag] of LINUX_TERMINALS) {
				if (!(await this.launcher.available(terminal))) continue;
				const keepOpen = `${line}; exec "\${SHELL:-sh}"`;
				await this.launcher.launch(terminal, [...flag, 'sh', '-c', keepOpen], command.cwd ? { cwd: command.cwd } : {});
				return { ok: true };
			}
			return { ok: false, reason: 'No supported terminal was found. Copy the command instead.' };
		} catch (error) {
			return { ok: false, reason: `Couldn't open a terminal (${errorCode(error)})` };
		}
	}

	async openFolder(path: string | null): Promise<ActionResult> {
		if (!path || !(await isDirectory(path))) {
			return { ok: false, reason: path ? `The folder no longer exists: ${path}` : 'This session has no recorded folder' };
		}
		const [executable, args] =
			this.platform === 'darwin' ? ['open', [path]] : this.platform === 'win32' ? ['explorer', [path]] : ['xdg-open', [path]];
		try {
			await this.launcher.launch(executable, args);
			return { ok: true };
		} catch (error) {
			return { ok: false, reason: `Couldn't open the folder (${errorCode(error)})` };
		}
	}
}

function errorCode(error: unknown): string {
	return (error as NodeJS.ErrnoException)?.code ?? 'error';
}

