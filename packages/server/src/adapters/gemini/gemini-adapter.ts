import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type {
	DiscoveredSession,
	NativeCommand,
	PreviewMessage,
	PreviewOptions,
	ProviderAdapter,
	ProviderAvailability,
	ScanContext,
	ScanResult,
	ScanWarning,
	Session
} from '@halcyon/core';
import { isValidNativeId, toSessionId } from '@halcyon/core';
import { isWrapperOnly, normalizeTime, PreviewCollector } from '../preview.js';
import { isIgnoredUserContent, parseGeminiConversation, replayGeminiText } from './conversation.js';

const PARSER_VERSION = 1;
const HASH_FOLDER = /^[0-9a-f]{64}$/;
const MAX_MARKER_BYTES = 16 * 1024;
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;

export interface GeminiAdapterOptions {
	/**
	 * Gemini CLI global directory; defaults to `$GEMINI_CLI_HOME/.gemini` or
	 * `~/.gemini`. The macOS seatbelt runtime directory beside it
	 * (`<home>/.cache/.gemini`) is scanned too when it exists.
	 */
	root?: string;
}

export function geminiStoreRoot(options: GeminiAdapterOptions = {}): string {
	return options.root ?? join(process.env.GEMINI_CLI_HOME || homedir(), '.gemini');
}

/** Runtime directories holding `tmp/<project>/chats`: the global dir, then the seatbelt variant. */
function runtimeDirs(root: string): string[] {
	return [root, join(dirname(root), '.cache', '.gemini')];
}

async function isReadableDir(path: string): Promise<boolean> {
	try {
		if (!(await stat(path)).isDirectory()) return false;
		await access(path, constants.R_OK | constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Discovers top-level Gemini CLI sessions from
 * `<runtime>/tmp/<projectId>/chats/session-*.jsonl` (and legacy `.json`).
 * Project folders are either legacy sha256 hashes of the project root or
 * registry slugs with a `.project_root` marker. Subagent subdirectories,
 * checkpoints, logs and quarantined/temporary files are ignored.
 */
export function createGeminiAdapter(options: GeminiAdapterOptions = {}): ProviderAdapter {
	const root = geminiStoreRoot(options);
	const tmpDirs = runtimeDirs(root).map((dir) => join(dir, 'tmp'));

	return {
		provider: 'gemini',
		displayName: 'Gemini CLI',
		parserVersion: PARSER_VERSION,

		async detect(): Promise<ProviderAvailability> {
			for (const dir of tmpDirs) {
				if (await isReadableDir(dir)) return { available: true, storePath: dir };
			}
			try {
				await stat(tmpDirs[0]!);
				return { available: false, reason: `Cannot read ${tmpDirs[0]}` };
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				return code === 'ENOENT'
					? { available: false, reason: `No Gemini CLI sessions found at ${tmpDirs[0]}` }
					: { available: false, reason: `Cannot read ${tmpDirs[0]} (${code ?? 'error'})` };
			}
		},

		async scan(context: ScanContext): Promise<ScanResult> {
			const warnings = new WarningCounter();
			const byId = new Map<string, DiscoveredSession>();
			let parsedCount = 0;

			for (const runtime of runtimeDirs(root)) {
				const tmp = join(runtime, 'tmp');
				if (!(await isReadableDir(tmp))) continue;
				const hashToRoot = await readRegistry(runtime, warnings);
				for (const project of await listProjects(tmp, warnings)) {
					context.signal?.throwIfAborted();
					const projectPath = await projectRootFor(project, hashToRoot);
					for (const file of await listChatFiles(project.dir, warnings)) {
						context.signal?.throwIfAborted();
						let size: number;
						let mtimeMs: number;
						try {
							const info = await stat(file);
							if (!info.isFile()) continue;
							size = info.size;
							mtimeMs = info.mtimeMs;
						} catch {
							warnings.add('unreadable-file');
							continue;
						}

						let discovered: DiscoveredSession | null = null;
						const cached = context.cache.get(file);
						if (
							cached &&
							cached.parserVersion === PARSER_VERSION &&
							cached.source.sizeBytes === size &&
							cached.source.mtimeMs === mtimeMs &&
							cached.session.provider === 'gemini'
						) {
							// The project mapping lives outside the file and can change.
							discovered = { session: { ...cached.session, projectPath }, source: cached.source };
						} else {
							let meta;
							try {
								meta = await parseGeminiConversation(file, size, context.signal);
							} catch (error) {
								if (context.signal?.aborted) throw error;
								warnings.add('unreadable-file');
								continue;
							}
							parsedCount++;
							if (!meta) {
								warnings.add('unsupported-schema');
								continue;
							}
							if (meta.malformedLines > 0) warnings.add('malformed-records', meta.malformedLines);
							if (meta.kind === 'subagent' || !meta.hasResumableContent) continue;
							if (!isValidNativeId(meta.sessionId, 'gemini')) {
								warnings.add('unsupported-schema');
								continue;
							}
							const lastAt = normalizeTime(meta.lastUpdated) ?? normalizeTime(meta.lastMessageAt);
							const session: Session = {
								id: toSessionId('gemini', meta.sessionId),
								provider: 'gemini',
								nativeId: meta.sessionId,
								title: meta.summary,
								titleSource: meta.summary ? 'provider-generated' : null,
								projectPath,
								latestPath: null,
								startedAt: normalizeTime(meta.startTime),
								lastActivityAt: lastAt ?? new Date(mtimeMs).toISOString(),
								lastActivitySource: lastAt ? 'transcript' : 'file-mtime',
								userTurnCount: meta.userTurnCount
							};
							discovered = { session, source: { path: file, sizeBytes: size, mtimeMs } };
						}

						// The same session can exist under a hash and a slug folder, or
						// as `.json` and `.jsonl` siblings; keep the later one, as Gemini CLI does.
						const existing = byId.get(discovered.session.id);
						if (!existing || activityMs(discovered.session) > activityMs(existing.session)) {
							byId.set(discovered.session.id, discovered);
						}
					}
				}
			}

			return { sessions: [...byId.values()], warnings: warnings.list(), parsedCount };
		},

		resumeCommand(session: Session): NativeCommand | null {
			// `--resume` only searches the current directory's project.
			if (!isValidNativeId(session.nativeId, 'gemini') || !session.projectPath) return null;
			return { executable: 'gemini', args: ['--resume', session.nativeId], cwd: session.projectPath };
		},

		async preview(sourcePath: string, options: PreviewOptions): Promise<PreviewMessage[]> {
			const inside = tmpDirs.some((dir) => sourcePath.startsWith(`${dir}/`) || sourcePath.startsWith(`${dir}\\`));
			if (!inside) throw new Error('Transcript is outside the provider store');
			const { size } = await stat(sourcePath);
			const items = await replayGeminiText(sourcePath, size, options.maxChars * 4 + 64, options.signal);
			const collector = new PreviewCollector(options);
			for (const item of items) {
				if (!item.role) continue;
				let text = item.text;
				if (item.role === 'user') {
					text = stripContext(text);
					if (isIgnoredUserContent(text.trim()) || isWrapperOnly(text)) continue;
				}
				collector.add(item.role, text, normalizeTime(item.at));
			}
			return collector.messages();
		}
	};
}

const CONTEXT_ELEMENT = /<(session_context|hook_context|system-reminder)>[\s\S]*?<\/\1>/g;

/** Removes context blocks Gemini CLI injects into user turns. */
function stripContext(text: string): string {
	return text.replace(CONTEXT_ELEMENT, '').trim();
}

function activityMs(session: Session): number {
	const ms = session.lastActivityAt ? Date.parse(session.lastActivityAt) : NaN;
	return Number.isFinite(ms) ? ms : 0;
}

interface ProjectFolder {
	dir: string;
	name: string;
}

async function listProjects(tmp: string, warnings: WarningCounter): Promise<ProjectFolder[]> {
	let entries;
	try {
		entries = await readdir(tmp, { withFileTypes: true });
	} catch {
		warnings.add('unreadable-file');
		return [];
	}
	return entries
		.filter((entry) => entry.isDirectory() && entry.name !== 'bin')
		.map((entry) => ({ dir: join(tmp, entry.name), name: entry.name }));
}

/** `session-*.jsonl` / `session-*.json` directly in `chats/`; subdirectories hold subagents. */
async function listChatFiles(projectDir: string, warnings: WarningCounter): Promise<string[]> {
	const chats = join(projectDir, 'chats');
	let entries;
	try {
		entries = await readdir(chats, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.add('unreadable-file');
		return [];
	}
	return entries
		.filter(
			(entry) =>
				entry.isFile() &&
				entry.name.startsWith('session-') &&
				(entry.name.endsWith('.jsonl') || entry.name.endsWith('.json')) &&
				!entry.name.includes('.unreadable-') &&
				!entry.name.includes('.tmp-')
		)
		.map((entry) => join(chats, entry.name));
}

/** sha256(project root) and `slug:<slug>` → project root, from `<runtime>/projects.json`, for legacy hash folders. */
async function readRegistry(runtime: string, warnings: WarningCounter): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	const path = join(runtime, 'projects.json');
	let raw: unknown;
	try {
		const info = await stat(path);
		if (!info.isFile() || info.size > MAX_REGISTRY_BYTES) return map;
		raw = JSON.parse(await readFile(path, 'utf8'));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.add('unreadable-file');
		return map;
	}
	const projects = raw && typeof raw === 'object' ? (raw as { projects?: unknown }).projects : undefined;
	if (!projects || typeof projects !== 'object') return map;
	for (const [key, slug] of Object.entries(projects as Record<string, unknown>)) {
		if (!isAbsolute(key)) continue;
		map.set(createHash('sha256').update(key).digest('hex'), key);
		if (typeof slug === 'string' && slug && !map.has(`slug:${slug}`)) map.set(`slug:${slug}`, key);
	}
	return map;
}

async function projectRootFor(project: ProjectFolder, hashToRoot: Map<string, string>): Promise<string | null> {
	try {
		const marker = join(project.dir, '.project_root');
		const info = await stat(marker);
		if (info.isFile() && info.size <= MAX_MARKER_BYTES) {
			const value = (await readFile(marker, 'utf8')).trim();
			if (value && isAbsolute(value) && !value.includes('\n')) return value;
		}
	} catch {
		// no marker: a legacy hash folder
	}
	if (HASH_FOLDER.test(project.name)) return hashToRoot.get(project.name) ?? null;
	// A slug folder whose marker is missing: fall back to the registry entry.
	return hashToRoot.get(`slug:${project.name}`) ?? null;
}

const WARNING_TEXT: Record<ScanWarning['code'], string> = {
	'malformed-records': 'Malformed session lines were skipped',
	'unreadable-file': 'Some Gemini CLI session files or project folders could not be read',
	'unsupported-schema': 'Some Gemini CLI session files use an unrecognized format',
	'index-mismatch': 'Some Gemini CLI session files disagree with their project folder'
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
