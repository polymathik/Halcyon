import { constants, type Dirent } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
	ActivitySource,
	DiscoveredSession,
	NativeCommand,
	ProviderAdapter,
	ProviderAvailability,
	ScanContext,
	ScanResult,
	ScanWarning,
	PreviewMessage,
	PreviewOptions,
	Session,
	TitleSource,
	LiveContext,
	ProviderLive
} from '@halcyon/core';
import { isValidNativeId, toSessionId } from '@halcyon/core';
import { parseRollout, ROLLOUT_FILE, type ExclusionReason } from './parse-rollout.js';
import { loadSessionIndex } from './session-index.js';
import { assertInside } from '../preview.js';
import { previewCodexRollout } from './preview.js';
import { codexLive } from './live.js';

const PARSER_VERSION = 1;

export interface CodexAdapterOptions {
	/** Codex home directory. Defaults to `$CODEX_HOME`, then `~/.codex`. */
	root?: string;
}

/** Aggregate numbers from the last scan, for diagnostics. No content. */
export interface CodexScanStats {
	rolloutFiles: number;
	included: number;
	excluded: Record<ExclusionReason, number>;
	fromCache: number;
	parsed: number;
	/** Rollout files that resolved to a session ID already seen this scan. */
	duplicateIds: number;
}

export interface CodexAdapter extends ProviderAdapter {
	lastScanStats(): CodexScanStats | null;
}

interface RolloutFile {
	path: string;
	filenameId: string | null;
}

/** Transcript-derived fields, from a fresh parse or a cached session. */
interface BaseFacts {
	nativeId: string;
	projectPath: string | null;
	latestPath: string | null;
	startedAt: string | null;
	activity: { at: string; source: ActivitySource } | null;
	userTurnCount: number | null;
	cachedTitle: { title: string; source: TitleSource } | null;
}

interface ExcludedMemo {
	sizeBytes: number;
	mtimeMs: number;
	reason: ExclusionReason;
}

export function createCodexAdapter(options: CodexAdapterOptions = {}): CodexAdapter {
	const root = options.root ?? (process.env.CODEX_HOME || join(homedir(), '.codex'));
	const sessionsDir = join(root, 'sessions');
	const indexPath = join(root, 'session_index.jsonl');

	// The shared ParseCache only stores sessions that were returned, so it cannot
	// remember that an unchanged file was excluded. Keep those decisions here for
	// the life of the process; after a restart an excluded file is re-read, but
	// only up to its first record (see parseRollout).
	const excludedMemo = new Map<string, ExcludedMemo>();
	let stats: CodexScanStats | null = null;

	return {
		provider: 'codex',
		displayName: 'Codex CLI',
		parserVersion: PARSER_VERSION,

		async detect(): Promise<ProviderAvailability> {
			try {
				const info = await stat(sessionsDir);
				if (!info.isDirectory()) {
					return { available: false, reason: `Codex sessions path is not a directory: ${sessionsDir}` };
				}
				await access(sessionsDir, constants.R_OK | constants.X_OK);
				return { available: true, storePath: sessionsDir };
			} catch (error) {
				const code = (error as NodeJS.ErrnoException)?.code;
				return {
					available: false,
					reason:
						code === 'ENOENT'
							? `No Codex sessions directory found at ${sessionsDir}`
							: `Codex sessions directory is not readable: ${sessionsDir}`
				};
			}
		},

		async scan(context: ScanContext): Promise<ScanResult> {
			const { cache, signal } = context;
			signal?.throwIfAborted();
			const counts = {
				malformedLines: 0,
				malformedFiles: 0,
				unreadable: 0,
				unsupported: 0,
				idMismatch: 0
			};
			const current: CodexScanStats = {
				rolloutFiles: 0,
				included: 0,
				excluded: { subagent: 0, 'ide-or-desktop': 0, 'non-interactive': 0, 'other-origin': 0, 'no-session-meta': 0 },
				fromCache: 0,
				parsed: 0,
				duplicateIds: 0
			};

			const index = await loadSessionIndex(indexPath, signal);
			const listing = await listRollouts(sessionsDir, signal);
			counts.unreadable += listing.unreadableDirs;
			current.rolloutFiles = listing.files.length;

			const byId = new Map<string, DiscoveredSession>();
			const seenPaths = new Set<string>();

			for (const file of listing.files) {
				signal?.throwIfAborted();
				seenPaths.add(file.path);
				let sizeBytes: number;
				let mtimeMs: number;
				try {
					const info = await stat(file.path);
					sizeBytes = info.size;
					mtimeMs = info.mtimeMs;
				} catch {
					counts.unreadable++;
					continue;
				}

				const memo = excludedMemo.get(file.path);
				if (memo && memo.sizeBytes === sizeBytes && memo.mtimeMs === mtimeMs) {
					current.excluded[memo.reason]++;
					continue;
				}

				let base: BaseFacts;
				const cached = cache.get(file.path);
				if (
					cached &&
					cached.parserVersion === PARSER_VERSION &&
					cached.source.sizeBytes === sizeBytes &&
					cached.source.mtimeMs === mtimeMs &&
					cached.session.provider === 'codex' &&
					isValidNativeId(cached.session.nativeId)
				) {
					base = fromCachedSession(cached.session);
					current.fromCache++;
				} else {
					let parsed;
					try {
						parsed = await parseRollout(file.path, file.filenameId, signal);
					} catch {
						signal?.throwIfAborted();
						counts.unreadable++;
						continue;
					}
					current.parsed++;
					if (parsed.malformedLines > 0) {
						counts.malformedLines += parsed.malformedLines;
						counts.malformedFiles++;
					}
					if (parsed.kind === 'excluded') {
						excludedMemo.set(file.path, { sizeBytes, mtimeMs, reason: parsed.reason });
						current.excluded[parsed.reason]++;
						if (parsed.reason === 'no-session-meta' && sizeBytes > 0) counts.unsupported++;
						continue;
					}
					excludedMemo.delete(file.path);
					if (parsed.facts.idMismatch) counts.idMismatch++;
					base = {
						...parsed.facts,
						activity: parsed.facts.lastRecordAt ? { at: parsed.facts.lastRecordAt, source: 'transcript' } : null,
						cachedTitle: null
					};
				}

				const session = buildSession(base, index, mtimeMs);
				const discovered: DiscoveredSession = { session, source: { path: file.path, sizeBytes, mtimeMs } };
				const existing = byId.get(session.id);
				if (existing) {
					current.duplicateIds++;
					byId.set(session.id, mergeSegments(existing, discovered));
				} else {
					byId.set(session.id, discovered);
				}
			}

			for (const path of excludedMemo.keys()) {
				if (!seenPaths.has(path)) excludedMemo.delete(path);
			}

			current.included = byId.size;
			stats = current;

			const warnings: ScanWarning[] = [];
			if (counts.malformedLines > 0) {
				warnings.push({
					code: 'malformed-records',
					message: `${counts.malformedLines} malformed lines skipped in ${counts.malformedFiles} Codex rollout files`,
					count: counts.malformedLines
				});
			}
			if (index.malformedLines > 0) {
				warnings.push({
					code: 'malformed-records',
					message: `${index.malformedLines} malformed lines skipped in the Codex session index`,
					count: index.malformedLines
				});
			}
			if (index.failed) {
				warnings.push({
					code: 'unreadable-file',
					message: 'The Codex session index could not be read; titles may be missing',
					count: 1
				});
			}
			if (counts.unreadable > 0) {
				warnings.push({
					code: 'unreadable-file',
					message: `${counts.unreadable} Codex rollout files or folders could not be read`,
					count: counts.unreadable
				});
			}
			if (counts.unsupported > 0) {
				warnings.push({
					code: 'unsupported-schema',
					message: `${counts.unsupported} Codex rollout files had no usable session metadata`,
					count: counts.unsupported
				});
			}
			if (counts.idMismatch > 0) {
				warnings.push({
					code: 'index-mismatch',
					message: `${counts.idMismatch} Codex rollout files have a session ID that differs from the filename`,
					count: counts.idMismatch
				});
			}

			return { sessions: [...byId.values()], warnings, parsedCount: current.parsed };
		},

		resumeCommand(session: Session): NativeCommand | null {
			if (session.provider !== 'codex' || !isValidNativeId(session.nativeId)) return null;
			return { executable: 'codex', args: ['resume', session.nativeId], cwd: session.projectPath };
		},

		async preview(sourcePath: string, options: PreviewOptions): Promise<PreviewMessage[]> {
			assertInside(sessionsDir, sourcePath);
			return previewCodexRollout(sourcePath, options);
		},

		live(context: LiveContext): Promise<ProviderLive> {
			return codexLive(root, context);
		},

		lastScanStats() {
			return stats;
		}
	};
}

/**
 * Enumerates `sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]`. `archived_sessions`
 * is deliberately ignored for the MVP: archived chats are hidden by Codex
 * itself and their resume behaviour is unverified.
 */
async function listRollouts(
	sessionsDir: string,
	signal?: AbortSignal
): Promise<{ files: RolloutFile[]; unreadableDirs: number }> {
	const files: RolloutFile[] = [];
	let unreadableDirs = 0;

	const subdirs = async (dir: string, pattern: RegExp): Promise<string[]> => {
		signal?.throwIfAborted();
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			unreadableDirs++;
			return [];
		}
		return entries
			.filter((entry) => entry.isDirectory() && pattern.test(entry.name))
			.map((entry) => join(dir, entry.name));
	};

	for (const year of await subdirs(sessionsDir, /^\d{4}$/)) {
		for (const month of await subdirs(year, /^\d{2}$/)) {
			for (const day of await subdirs(month, /^\d{2}$/)) {
				signal?.throwIfAborted();
				let entries: Dirent[];
				try {
					entries = await readdir(day, { withFileTypes: true });
				} catch {
					unreadableDirs++;
					continue;
				}
				for (const entry of entries) {
					if (!entry.isFile()) continue;
					const match = ROLLOUT_FILE.exec(entry.name);
					if (!match) continue;
					files.push({ path: join(day, entry.name), filenameId: match[1] ?? null });
				}
			}
		}
	}
	return { files, unreadableDirs };
}

function fromCachedSession(session: Session): BaseFacts {
	return {
		nativeId: session.nativeId.toLowerCase(),
		projectPath: session.projectPath,
		latestPath: session.latestPath,
		startedAt: session.startedAt,
		// A cached index-derived time already includes the transcript time it was
		// compared with, so it remains a valid lower bound for this scan.
		activity:
			session.lastActivityAt && session.lastActivitySource && session.lastActivitySource !== 'file-mtime'
				? { at: session.lastActivityAt, source: session.lastActivitySource }
				: null,
		userTurnCount: session.userTurnCount,
		cachedTitle: session.title && session.titleSource ? { title: session.title, source: session.titleSource } : null
	};
}

function buildSession(
	base: BaseFacts,
	index: Awaited<ReturnType<typeof loadSessionIndex>>,
	mtimeMs: number
): Session {
	const entry = index.entries.get(base.nativeId);

	let title: string | null = null;
	let titleSource: TitleSource | null = null;
	if (entry?.title) {
		title = entry.title;
		titleSource = 'provider-index';
	} else if (index.failed && base.cachedTitle) {
		({ title, source: titleSource } = base.cachedTitle);
	}

	let activity = base.activity;
	if (entry?.updatedAt && (!activity || entry.updatedAt > activity.at)) {
		activity = { at: entry.updatedAt, source: 'provider-index' };
	}
	activity ??= { at: new Date(mtimeMs).toISOString(), source: 'file-mtime' };

	return {
		id: toSessionId('codex', base.nativeId),
		provider: 'codex',
		nativeId: base.nativeId,
		title,
		titleSource,
		projectPath: base.projectPath,
		latestPath: base.latestPath,
		startedAt: base.startedAt,
		lastActivityAt: activity.at,
		lastActivitySource: activity.source,
		userTurnCount: base.userTurnCount
	};
}

/**
 * Paginated Codex sessions can be split across several rollout files that
 * share one session ID. Keep the segment with the newest activity as the
 * source, and the earliest start time across segments. Turn counts are not
 * summed: whether a segment repeats earlier history is unverified.
 */
function mergeSegments(a: DiscoveredSession, b: DiscoveredSession): DiscoveredSession {
	const newer = (b.session.lastActivityAt ?? '') > (a.session.lastActivityAt ?? '') ? b : a;
	const older = newer === a ? b : a;
	const starts = [a.session.startedAt, b.session.startedAt].filter((value): value is string => value !== null);
	return {
		source: newer.source,
		session: {
			...newer.session,
			startedAt: starts.length > 0 ? starts.sort()[0]! : null,
			projectPath: newer.session.projectPath ?? older.session.projectPath
		}
	};
}
