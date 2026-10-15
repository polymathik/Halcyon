import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
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
	Session
} from '@halcyon/core';
import { isValidNativeId, toSessionId } from '@halcyon/core';
import { assertInside } from '../preview.js';
import { qwenLive } from './live.js';
import { parseQwenTranscript, previewQwenTranscript } from './transcript.js';

const PARSER_VERSION = 1;
/** `<sessionId>.jsonl`; sidecars (`.ledger.jsonl`, `.worktree.json`, `.pr.json`) never match. */
const TRANSCRIPT_FILE = /^([0-9a-fA-F-]{32,36})\.jsonl$/;

export interface QwenAdapterOptions {
	/** Qwen Code global directory; defaults to `$QWEN_HOME` or `~/.qwen`. */
	root?: string;
	/**
	 * Runtime base holding `projects/`; defaults to `$QWEN_RUNTIME_DIR`, else the
	 * global directory. When `root` is given, defaults to `root`.
	 */
	runtimeDir?: string;
}

export function qwenHome(options: QwenAdapterOptions = {}): string {
	return options.root ?? (process.env.QWEN_HOME || join(homedir(), '.qwen'));
}

function qwenRuntime(options: QwenAdapterOptions): string {
	if (options.runtimeDir) return options.runtimeDir;
	if (options.root) return options.root;
	return process.env.QWEN_RUNTIME_DIR || qwenHome(options);
}

/**
 * Discovers Qwen Code sessions from `<runtime>/projects/<sanitized cwd>/chats/<id>.jsonl`.
 * Archived sessions (`chats/archive/`) and sidecar files are ignored. The
 * per-project `runtimeOutputDir` setting is not followed.
 */
export function createQwenAdapter(options: QwenAdapterOptions = {}): ProviderAdapter {
	const home = qwenHome(options);
	const projectsDir = join(qwenRuntime(options), 'projects');

	return {
		provider: 'qwen',
		displayName: 'Qwen Code',
		parserVersion: PARSER_VERSION,

		async detect(): Promise<ProviderAvailability> {
			try {
				const info = await stat(projectsDir);
				if (!info.isDirectory()) return { available: false, reason: `${projectsDir} is not a directory` };
				await access(projectsDir, constants.R_OK | constants.X_OK);
				return { available: true, storePath: projectsDir };
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				return code === 'ENOENT'
					? { available: false, reason: `No Qwen Code sessions found at ${projectsDir}` }
					: { available: false, reason: `Cannot read ${projectsDir} (${code ?? 'error'})` };
			}
		},

		async scan(context: ScanContext): Promise<ScanResult> {
			const warnings = new WarningCounter();
			const sessions: DiscoveredSession[] = [];
			const seen = new Set<string>();
			let parsedCount = 0;

			for (const file of await listTranscripts(projectsDir, warnings)) {
				context.signal?.throwIfAborted();
				if (!isValidNativeId(file.nativeId, 'qwen')) {
					warnings.add('unsupported-schema');
					continue;
				}
				let size: number;
				let mtimeMs: number;
				try {
					const info = await stat(file.path);
					if (!info.isFile()) continue;
					size = info.size;
					mtimeMs = info.mtimeMs;
				} catch {
					warnings.add('unreadable-file');
					continue;
				}

				const id = toSessionId('qwen', file.nativeId);
				const cached = context.cache.get(file.path);
				if (
					cached &&
					cached.parserVersion === PARSER_VERSION &&
					cached.source.sizeBytes === size &&
					cached.source.mtimeMs === mtimeMs &&
					cached.session.provider === 'qwen'
				) {
					if (!seen.has(id)) {
						seen.add(id);
						sessions.push({ session: cached.session, source: cached.source });
					}
					continue;
				}

				let meta;
				try {
					meta = await parseQwenTranscript(file.path, context.signal);
				} catch (error) {
					if (context.signal?.aborted) throw error;
					warnings.add('unreadable-file');
					continue;
				}
				parsedCount++;
				if (meta.malformedLines > 0) warnings.add('malformed-records', meta.malformedLines);
				if (meta.recordCount === 0) continue; // an empty stub
				// Qwen Code lists a session only when its first record names it.
				if (meta.sessionId === null || meta.sessionId.toLowerCase() !== file.nativeId.toLowerCase()) {
					warnings.add('index-mismatch');
					continue;
				}
				if (seen.has(id)) {
					warnings.add('index-mismatch');
					continue;
				}
				seen.add(id);

				const nativeId = file.nativeId.toLowerCase();
				const session: Session = {
					id,
					provider: 'qwen',
					nativeId,
					title: meta.title,
					titleSource: meta.titleSource,
					projectPath: meta.firstCwd,
					latestPath: meta.lastCwd !== null && meta.lastCwd !== meta.firstCwd ? meta.lastCwd : null,
					startedAt: meta.startedAtMs !== null ? new Date(meta.startedAtMs).toISOString() : null,
					lastActivityAt: new Date(meta.lastActivityAtMs ?? mtimeMs).toISOString(),
					lastActivitySource: meta.lastActivityAtMs !== null ? 'transcript' : 'file-mtime',
					userTurnCount: meta.userTurnCount
				};
				sessions.push({ session, source: { path: file.path, sizeBytes: size, mtimeMs } });
			}

			return { sessions, warnings: warnings.list(), parsedCount };
		},

		resumeCommand(session: Session): NativeCommand | null {
			// `--resume` looks the session up in the current directory's project.
			if (!isValidNativeId(session.nativeId, 'qwen') || !session.projectPath) return null;
			return { executable: 'qwen', args: ['--resume', session.nativeId], cwd: session.projectPath };
		},

		async preview(sourcePath: string, options: PreviewOptions): Promise<PreviewMessage[]> {
			assertInside(projectsDir, sourcePath);
			return previewQwenTranscript(sourcePath, options);
		},

		live(context: LiveContext): Promise<ProviderLive> {
			return qwenLive(home, context);
		}
	};
}

interface TranscriptFile {
	path: string;
	nativeId: string;
}

/** Lists `<projects>/*\/chats/<id>.jsonl`. `chats/archive/` is a directory and is not entered. */
async function listTranscripts(projectsDir: string, warnings: WarningCounter): Promise<TranscriptFile[]> {
	let projects;
	try {
		projects = await readdir(projectsDir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw new Error(`Cannot read Qwen Code projects directory (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
	}
	const files: TranscriptFile[] = [];
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		const chats = join(projectsDir, project.name, 'chats');
		let entries;
		try {
			entries = await readdir(chats, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.add('unreadable-file');
			continue;
		}
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			const match = TRANSCRIPT_FILE.exec(entry.name);
			if (match?.[1]) files.push({ path: join(chats, entry.name), nativeId: match[1] });
		}
	}
	return files;
}

const WARNING_TEXT: Record<ScanWarning['code'], string> = {
	'malformed-records': 'Malformed transcript lines were skipped',
	'unreadable-file': 'Some Qwen Code transcripts or project folders could not be read',
	'unsupported-schema': 'Some Qwen Code transcripts have an unrecognized name or format',
	'index-mismatch': 'Some Qwen Code transcripts record a session ID that differs from their filename'
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
