import { constants } from 'node:fs';
import { access, open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
	DiscoveredSession,
	LiveContext,
	NativeCommand,
	PreviewMessage,
	PreviewOptions,
	ProviderAdapter,
	ProviderAvailability,
	ProviderLive,
	ScanContext,
	ScanResult,
	ScanWarning,
	Session,
	SourceFingerprint
} from '@halcyon/core';
import { isValidNativeId, toSessionId } from '@halcyon/core';
import { assertInside } from '../preview.js';
import { parseCopilotEvents, previewCopilotEvents } from './events.js';
import { copilotLive } from './live.js';
import { parseWorkspaceYaml, type CopilotWorkspace } from './workspace-yaml.js';

const PARSER_VERSION = 1;
const MAX_YAML_BYTES = 256 * 1024;

export interface CopilotAdapterOptions {
	/** Copilot CLI home; defaults to `$COPILOT_HOME` or `~/.copilot`. */
	root?: string;
	/**
	 * Extra `session-state` folders to scan. Defaults to
	 * `$XDG_STATE_HOME/.copilot/session-state` when that variable is set and
	 * `root` is not given; tests pass it explicitly.
	 */
	fallbackStateDirs?: string[];
}

export function copilotHome(options: CopilotAdapterOptions = {}): string {
	return options.root ?? (process.env.COPILOT_HOME || join(homedir(), '.copilot'));
}

function fallbackDirs(options: CopilotAdapterOptions): string[] {
	if (options.fallbackStateDirs) return options.fallbackStateDirs;
	if (options.root) return [];
	const xdg = process.env.XDG_STATE_HOME;
	return xdg ? [join(xdg, '.copilot', 'session-state')] : [];
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Discovers GitHub Copilot CLI sessions from
 * `<home>/session-state/<uuid>/{events.jsonl,workspace.yaml}`. Subagent events,
 * detached maintenance sessions and sessions with no typed prompt are skipped.
 */
export function createCopilotAdapter(options: CopilotAdapterOptions = {}): ProviderAdapter {
	const root = copilotHome(options);
	const primary = join(root, 'session-state');
	const stateDirs = [primary, ...fallbackDirs(options).filter((dir) => dir !== primary)];

	return {
		provider: 'copilot',
		displayName: 'GitHub Copilot CLI',
		parserVersion: PARSER_VERSION,

		async detect(): Promise<ProviderAvailability> {
			for (const dir of stateDirs) {
				try {
					const info = await stat(dir);
					if (!info.isDirectory()) continue;
					await access(dir, constants.R_OK | constants.X_OK);
					return { available: true, storePath: dir };
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code !== 'ENOENT') return { available: false, reason: `Cannot read ${dir} (${code ?? 'error'})` };
				}
			}
			// No sessions yet: available (empty) only when Copilot's home exists.
			if (await isDirectory(root)) return { available: true, storePath: primary };
			return { available: false, reason: `No GitHub Copilot CLI sessions found at ${primary}` };
		},

		async scan(context: ScanContext): Promise<ScanResult> {
			const warnings = new WarningCounter();
			const sessions: DiscoveredSession[] = [];
			const seenIds = new Set<string>();
			const seenDirs = new Set<string>();
			let parsedCount = 0;

			for (const stateDir of stateDirs) {
				let entries;
				try {
					entries = await readdir(stateDir, { withFileTypes: true });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.add('unreadable-file');
					continue;
				}
				for (const entry of entries) {
					context.signal?.throwIfAborted();
					if (!entry.isDirectory()) continue;
					if (!isValidNativeId(entry.name, 'copilot')) {
						warnings.add('unsupported-schema');
						continue;
					}
					const nativeId = entry.name.toLowerCase();
					const dir = join(stateDir, entry.name);
					let real = dir;
					try {
						real = await realpath(dir);
					} catch {
						// keep the listed path
					}
					if (seenIds.has(nativeId) || seenDirs.has(real)) continue;
					seenIds.add(nativeId);
					seenDirs.add(real);

					const eventsPath = join(dir, 'events.jsonl');
					let events;
					try {
						events = await stat(eventsPath);
						if (!events.isFile()) continue;
					} catch {
						continue; // nothing recorded: an empty stub
					}
					const yaml = await readWorkspace(join(dir, 'workspace.yaml'));
					const source: SourceFingerprint = {
						path: eventsPath,
						sizeBytes: events.size + (yaml?.size ?? 0),
						mtimeMs: Math.max(events.mtimeMs, yaml?.mtimeMs ?? 0)
					};

					const cached = context.cache.get(eventsPath);
					if (
						cached &&
						cached.parserVersion === PARSER_VERSION &&
						cached.source.sizeBytes === source.sizeBytes &&
						cached.source.mtimeMs === source.mtimeMs &&
						cached.session.provider === 'copilot'
					) {
						sessions.push({ session: cached.session, source: cached.source });
						continue;
					}

					let meta;
					try {
						meta = await parseCopilotEvents(eventsPath, context.signal);
					} catch (error) {
						if (context.signal?.aborted) throw error;
						warnings.add('unreadable-file');
						continue;
					}
					parsedCount++;
					if (meta.stats.malformedLines > 0) warnings.add('malformed-records', meta.stats.malformedLines);
					if (meta.detached || meta.userTurnCount === 0) continue;
					const ws = yaml?.workspace ?? null;
					if (ws?.id && ws.id.toLowerCase() !== nativeId) warnings.add('index-mismatch');

					const title = titleOf(ws, meta.title);
					const projectPath = meta.firstCwd ?? ws?.cwd ?? null;
					const latest = meta.lastCwd ?? ws?.cwd ?? null;
					const lastActivityAt = ws?.updatedAt ?? meta.lastEventAt;
					const session: Session = {
						id: toSessionId('copilot', nativeId),
						provider: 'copilot',
						nativeId,
						title: title.title,
						titleSource: title.source,
						projectPath,
						latestPath: latest !== null && latest !== projectPath ? latest : null,
						startedAt: meta.startedAt ?? ws?.createdAt ?? null,
						lastActivityAt: lastActivityAt ?? new Date(events.mtimeMs).toISOString(),
						lastActivitySource: ws?.updatedAt ? 'provider-index' : meta.lastEventAt ? 'transcript' : 'file-mtime',
						userTurnCount: meta.userTurnCount
					};
					sessions.push({ session, source });
				}
			}

			return { sessions, warnings: warnings.list(), parsedCount };
		},

		resumeCommand(session: Session): NativeCommand | null {
			if (!isValidNativeId(session.nativeId, 'copilot')) return null;
			return {
				executable: 'copilot',
				args: ['--resume', session.nativeId],
				cwd: session.latestPath ?? session.projectPath
			};
		},

		async preview(sourcePath: string, options: PreviewOptions): Promise<PreviewMessage[]> {
			if (!sourcePath.endsWith('/events.jsonl') && !sourcePath.endsWith('\\events.jsonl')) {
				throw new Error('Transcript is outside the provider store');
			}
			let inside = false;
			for (const dir of stateDirs) {
				try {
					assertInside(dir, sourcePath);
					inside = true;
					break;
				} catch {
					// try the next store
				}
			}
			if (!inside) throw new Error('Transcript is outside the provider store');
			return previewCopilotEvents(sourcePath, options);
		},

		live(context: LiveContext): Promise<ProviderLive> {
			return copilotLive(stateDirs, context);
		}
	};
}

function titleOf(
	ws: CopilotWorkspace | null,
	eventTitle: string | null
): { title: string | null; source: Session['titleSource'] } {
	if (ws?.name) return { title: ws.name, source: ws.userNamed ? 'custom' : 'provider-generated' };
	if (eventTitle) return { title: eventTitle, source: 'provider-generated' };
	if (ws?.summary) return { title: ws.summary, source: 'provider-generated' };
	return { title: null, source: null };
}

async function readWorkspace(
	path: string
): Promise<{ workspace: CopilotWorkspace; size: number; mtimeMs: number } | null> {
	let handle;
	try {
		handle = await open(path, 'r');
		const info = await handle.stat();
		if (!info.isFile() || info.size > MAX_YAML_BYTES) return null;
		return { workspace: parseWorkspaceYaml(await handle.readFile('utf8')), size: info.size, mtimeMs: info.mtimeMs };
	} catch {
		return null;
	} finally {
		await handle?.close();
	}
}

const WARNING_TEXT: Record<ScanWarning['code'], string> = {
	'malformed-records': 'Malformed event lines were skipped',
	'unreadable-file': 'Some GitHub Copilot CLI sessions or folders could not be read',
	'unsupported-schema': 'Some GitHub Copilot CLI session folders have an unrecognized name or format',
	'index-mismatch': 'Some GitHub Copilot CLI sessions record an ID that differs from their folder'
};

class WarningCounter {
	private counts = new Map<ScanWarning['code'], number>();

	add(code: ScanWarning['code'], count = 1): void {
		this.counts.set(code, (this.counts.get(code) ?? 0) + count);
	}

	list(): ScanWarning[] {
		return [...this.counts].map(([code, count]) => ({ code, message: WARNING_TEXT[code], count }));
	}
}
