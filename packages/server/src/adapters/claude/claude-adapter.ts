import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
	DiscoveredSession,
	NativeCommand,
	ProviderAdapter,
	ProviderAvailability,
	ScanContext,
	ScanResult,
	PreviewMessage,
	PreviewOptions,
	ScanWarning,
	Session
} from '@halcyon/core';
import { isValidNativeId, toSessionId } from '@halcyon/core';
import { assertInside } from '../preview.js';
import { previewClaudeTranscript } from './preview.js';
import { parseClaudeTranscript } from './transcript.js';

const PARSER_VERSION = 1;
const TRANSCRIPT_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export interface ClaudeAdapterOptions {
	/** Claude config directory; defaults to `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
	root?: string;
}

export function claudeStoreRoot(options: ClaudeAdapterOptions = {}): string {
	return options.root ?? (process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));
}

/**
 * Discovers top-level Claude Code sessions from
 * `<root>/projects/<encoded-project>/<uuid>.jsonl`. Subdirectories (subagent
 * transcripts, memory) and `sessions-index.json` are ignored: the indexes were
 * found to be stale, and subagents are not independently resumable.
 */
export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): ProviderAdapter {
	const root = claudeStoreRoot(options);
	const projectsDir = join(root, 'projects');

	return {
		provider: 'claude',
		displayName: 'Claude Code',
		parserVersion: PARSER_VERSION,

		async detect(): Promise<ProviderAvailability> {
			try {
				const info = await stat(projectsDir);
				if (!info.isDirectory()) {
					return { available: false, reason: `${projectsDir} is not a directory` };
				}
				await access(projectsDir, constants.R_OK | constants.X_OK);
				return { available: true, storePath: projectsDir };
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === 'ENOENT') {
					return {
						available: false,
						reason: `No Claude Code session store found at ${projectsDir}`
					};
				}
				return { available: false, reason: `Cannot read ${projectsDir} (${code ?? 'error'})` };
			}
		},

		async scan(context: ScanContext): Promise<ScanResult> {
			const warnings = new WarningCounter();
			const sessions: DiscoveredSession[] = [];
			let parsedCount = 0;

			const files = await listTranscripts(projectsDir, warnings);
			for (const file of files) {
				context.signal?.throwIfAborted();

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

				const cached = context.cache.get(file.path);
				if (
					cached &&
					cached.parserVersion === PARSER_VERSION &&
					cached.source.sizeBytes === size &&
					cached.source.mtimeMs === mtimeMs &&
					cached.session.provider === 'claude'
				) {
					sessions.push({ session: cached.session, source: cached.source });
					continue;
				}

				let meta;
				try {
					meta = await parseClaudeTranscript(file.path, context.signal);
				} catch (error) {
					if (context.signal?.aborted) throw error;
					warnings.add('unreadable-file');
					continue;
				}
				parsedCount++;

				if (meta.stats.malformedLines > 0) warnings.add('malformed-records', meta.stats.malformedLines);
				// The filename is authoritative: it is what `claude --resume` and
				// the provider's own file layout use.
				const mismatched = [...meta.sessionIds].some(
					(id) => id.toLowerCase() !== file.nativeId.toLowerCase()
				);
				if (mismatched) warnings.add('index-mismatch');

				const projectPath = meta.firstCwd;
				const session: Session = {
					id: toSessionId('claude', file.nativeId),
					provider: 'claude',
					nativeId: file.nativeId,
					title: meta.title,
					titleSource: meta.titleSource,
					projectPath,
					latestPath: meta.lastCwd !== null && meta.lastCwd !== projectPath ? meta.lastCwd : null,
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
			if (!isValidNativeId(session.nativeId)) return null;
			return { executable: 'claude', args: ['--resume', session.nativeId], cwd: session.projectPath };
		},

		async preview(sourcePath: string, options: PreviewOptions): Promise<PreviewMessage[]> {
			assertInside(projectsDir, sourcePath);
			return previewClaudeTranscript(sourcePath, options);
		}
	};
}

interface TranscriptFile {
	path: string;
	nativeId: string;
}

/** Lists `<projects>/*\/<uuid>.jsonl`, one level deep. A missing store is empty. */
async function listTranscripts(projectsDir: string, warnings: WarningCounter): Promise<TranscriptFile[]> {
	let projects;
	try {
		projects = await readdir(projectsDir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw new Error(`Cannot read Claude Code projects directory (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
	}

	const files: TranscriptFile[] = [];
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		const dir = join(projectsDir, project.name);
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			warnings.add('unreadable-file');
			continue;
		}
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			const match = TRANSCRIPT_FILE.exec(entry.name);
			if (match?.[1]) files.push({ path: join(dir, entry.name), nativeId: match[1] });
		}
	}
	return files;
}

const WARNING_TEXT: Record<ScanWarning['code'], string> = {
	'malformed-records': 'Malformed transcript lines were skipped',
	'unreadable-file': 'Some Claude Code transcripts or project folders could not be read',
	'unsupported-schema': 'Some transcripts use an unrecognized format',
	'index-mismatch': 'Some transcripts record a session ID that differs from their filename'
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
