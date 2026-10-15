import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type {
	DiscoveredSession,
	NativeCommand,
	PreviewMessage,
	PreviewOptions,
	ProviderAdapter,
	ProviderAvailability,
	ScanContext,
	ScanResult,
	Session
} from '@halcyon/core';
import { isValidNativeId, toSessionId } from '@halcyon/core';
import { openReadOnlyDatabase, type Database } from '../../db/sqlite.js';
import { assertInside } from '../preview.js';
import {
	countLegacyUserTurns,
	legacyFingerprint,
	listLegacySessionFiles,
	previewLegacySession,
	readLegacySession,
	readLegacyWorktree
} from './legacy.js';
import {
	asCount,
	asString,
	collectPreview,
	fileState,
	hasColumns,
	isDirectory,
	msToIso,
	parseSqliteSourcePath,
	sqliteSourcePath,
	tableColumns,
	WarningCounter
} from '../sqlite-store.js';

const PARSER_VERSION = 1;

/** Columns the session list needs; anything else is optional. */
const SESSION_COLUMNS = ['id', 'parent_id', 'directory', 'title', 'time_created', 'time_updated'] as const;
const MESSAGE_COLUMNS = ['id', 'session_id', 'time_created', 'data'] as const;
const PART_COLUMNS = ['id', 'message_id', 'data'] as const;

/**
 * A text part that is neither synthetic nor ignored. CASE guards the JSON
 * functions so one malformed row cannot fail the whole query.
 */
const VISIBLE_TEXT_PART = `(CASE WHEN json_valid(p.data)
	THEN json_extract(p.data, '$.type') = 'text'
	     AND COALESCE(json_extract(p.data, '$.synthetic'), 0) = 0
	     AND COALESCE(json_extract(p.data, '$.ignored'), 0) = 0
	     AND length(trim(COALESCE(json_extract(p.data, '$.text'), ''))) > 0
	ELSE 0 END)`;

/**
 * OpenCode's placeholder titles (`Session.isDefaultTitle` in
 * packages/opencode/src/session/session.ts): the title is replaced by a
 * generated one after the first exchange, so a placeholder carries no meaning.
 */
const DEFAULT_TITLE = /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface OpenCodeFamilyConfig {
	provider: 'opencode' | 'kilo';
	displayName: string;
	/** CLI executable used to resume. */
	executable: string;
	/** Folder name under the XDG data home, e.g. `opencode`. */
	appDir: string;
	/** Database file name inside the data dir, e.g. `opencode.db`. */
	dbFile: string;
	/** Environment variable that overrides the database path. */
	dbEnv: string;
}

export interface OpenCodeFamilyOptions {
	/** Data directory; defaults to `${XDG_DATA_HOME:-~/.local/share}/<appDir>`. */
	root?: string;
	/** Database path override; defaults to `$<dbEnv>` (only without `root`), then `<root>/<dbFile>`. */
	dbPath?: string;
}

export function openCodeFamilyPaths(
	config: OpenCodeFamilyConfig,
	options: OpenCodeFamilyOptions = {}
): { root: string; dbPath: string | null; storageDir: string } {
	const root = options.root ?? join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), config.appDir);
	let dbPath: string | null = options.dbPath ?? join(root, config.dbFile);
	if (options.dbPath === undefined && options.root === undefined) {
		const override = process.env[config.dbEnv];
		if (override) dbPath = override === ':memory:' ? null : isAbsolute(override) ? override : join(root, override);
	}
	return { root, dbPath: dbPath === null ? null : resolve(dbPath), storageDir: join(root, 'storage') };
}

/**
 * Adapter for OpenCode and its forks that share its storage (Kilo Code CLI).
 * Reads the SQLite store (`session`, `message`, `part`, `project` tables,
 * OpenCode 1.2+) and falls back to the pre-1.2 JSON layout under
 * `<data>/storage` when no database exists. Never writes either.
 */
export function createOpenCodeFamilyAdapter(
	config: OpenCodeFamilyConfig,
	options: OpenCodeFamilyOptions = {}
): ProviderAdapter {
	const { provider, displayName } = config;
	const { dbPath, storageDir } = openCodeFamilyPaths(config, options);
	const legacySessionDir = join(storageDir, 'session');

	type Store = { kind: 'db'; path: string } | { kind: 'legacy'; path: string } | null;
	async function locate(): Promise<{ store: Store; reason: string }> {
		if (dbPath) {
			const state = await fileState(dbPath);
			if (state === 'file') return { store: { kind: 'db', path: dbPath }, reason: '' };
			if (state === 'unreadable' || state === 'not-file') {
				return { store: null, reason: `${displayName} database is not readable: ${dbPath}` };
			}
		}
		if (await isDirectory(legacySessionDir)) return { store: { kind: 'legacy', path: legacySessionDir }, reason: '' };
		return { store: null, reason: `No ${displayName} sessions found at ${dbPath ?? legacySessionDir}` };
	}

	return {
		provider,
		displayName,
		parserVersion: PARSER_VERSION,

		async detect(): Promise<ProviderAvailability> {
			const { store, reason } = await locate();
			if (!store) return { available: false, reason };
			if (store.kind === 'legacy') return { available: true, storePath: store.path };
			let db: Database | undefined;
			try {
				db = openReadOnlyDatabase(store.path);
				if (!hasColumns(tableColumns(db, 'session'), SESSION_COLUMNS)) {
					return { available: false, reason: `${displayName} database has an unsupported schema: ${store.path}` };
				}
				return { available: true, storePath: store.path };
			} catch {
				return { available: false, reason: `${displayName} database could not be opened: ${store.path}` };
			} finally {
				db?.close();
			}
		},

		async scan(context: ScanContext): Promise<ScanResult> {
			context.signal?.throwIfAborted();
			const { store } = await locate();
			if (!store) return { sessions: [], warnings: [], parsedCount: 0 };
			if (store.kind === 'legacy') return scanLegacy(config, storageDir, context);
			return scanDatabase(config, store.path);
		},

		resumeCommand(session: Session): NativeCommand | null {
			if (session.provider !== provider || !isValidNativeId(session.nativeId, provider)) return null;
			const directory = session.projectPath && isAbsolute(session.projectPath) ? session.projectPath : null;
			return {
				executable: config.executable,
				args: directory ? [directory, '--session', session.nativeId] : ['--session', session.nativeId],
				cwd: directory
			};
		},

		async preview(sourcePath: string, previewOptions: PreviewOptions): Promise<PreviewMessage[]> {
			if (sourcePath.endsWith('.json') && !sourcePath.includes('#')) {
				assertInside(legacySessionDir, sourcePath);
				return previewLegacySession(storageDir, sourcePath, previewOptions);
			}
			const { dbPath: db, nativeId } = parseSqliteSourcePath(sourcePath, (path) => path === dbPath);
			if (!isValidNativeId(nativeId, provider)) throw new Error('Invalid session ID');
			return previewDatabase(db, nativeId, previewOptions);
		}
	};
}

/** OpenCode stores paths with forward slashes on Windows. */
function platformPath(path: string): string {
	if (process.platform !== 'win32' || !/^[A-Za-z]:\/|^\/\//.test(path)) return path;
	return path.replaceAll('/', '\\');
}

function projectPathOf(directory: string | null, worktree: string | null): string | null {
	if (directory) return platformPath(directory);
	// The global (non-git) project's worktree is "/", which says nothing.
	if (worktree && worktree !== '/') return platformPath(worktree);
	return null;
}

function titleOf(title: string | null): string | null {
	if (!title || DEFAULT_TITLE.test(title)) return null;
	return title;
}

function scanDatabase(config: OpenCodeFamilyConfig, dbPath: string): ScanResult {
	const { provider, displayName } = config;
	const warnings = new WarningCounter();
	let db: Database | undefined;
	try {
		db = openReadOnlyDatabase(dbPath);
		const sessionColumns = tableColumns(db, 'session');
		if (!hasColumns(sessionColumns, SESSION_COLUMNS)) {
			warnings.add('unsupported-schema', `The ${displayName} session table is missing required columns`);
			return { sessions: [], warnings: warnings.list(), parsedCount: 0 };
		}
		const hasProject =
			sessionColumns.has('project_id') && hasColumns(tableColumns(db, 'project'), ['id', 'worktree']);
		const archived = sessionColumns.has('time_archived') ? 'AND s.time_archived IS NULL' : '';
		const rows = db
			.prepare(
				`SELECT s.id AS id, s.directory AS directory, s.title AS title,
				        s.time_created AS created, s.time_updated AS updated,
				        ${hasProject ? 'p.worktree' : 'NULL'} AS worktree
				 FROM session s ${hasProject ? 'LEFT JOIN project p ON p.id = s.project_id' : ''}
				 WHERE s.parent_id IS NULL ${archived}
				 ORDER BY s.time_updated DESC`
			)
			.all() as Record<string, unknown>[];

		const turns = userTurnCounts(db, warnings, displayName);
		const sessions: DiscoveredSession[] = [];
		const seen = new Set<string>();
		let invalid = 0;
		for (const row of rows) {
			const nativeId = asString(row.id);
			if (!nativeId || !isValidNativeId(nativeId, provider)) {
				invalid++;
				continue;
			}
			if (seen.has(nativeId)) continue;
			seen.add(nativeId);
			const updatedMs = typeof row.updated === 'number' ? row.updated : 0;
			const lastActivityAt = msToIso(row.updated);
			sessions.push({
				session: {
					id: toSessionId(provider, nativeId),
					provider,
					nativeId,
					title: titleOf(asString(row.title)),
					titleSource: titleOf(asString(row.title)) ? 'provider-generated' : null,
					projectPath: projectPathOf(asString(row.directory), asString(row.worktree)),
					latestPath: null,
					startedAt: msToIso(row.created),
					lastActivityAt,
					lastActivitySource: lastActivityAt ? 'transcript' : null,
					userTurnCount: turns ? (turns.get(nativeId) ?? 0) : null
				},
				source: { path: sqliteSourcePath(dbPath, nativeId), sizeBytes: 0, mtimeMs: updatedMs }
			});
		}
		warnings.add('malformed-records', `${displayName} sessions with an invalid ID were skipped`, invalid);
		return { sessions, warnings: warnings.list(), parsedCount: sessions.length };
	} catch {
		warnings.add('unreadable-file', `The ${displayName} database could not be read`);
		return { sessions: [], warnings: warnings.list(), parsedCount: 0 };
	} finally {
		db?.close();
	}
}

/**
 * One aggregate over `message`: user messages with at least one text part that
 * is neither synthetic nor ignored (OpenCode marks injected file reads,
 * compaction prompts and auto-continue messages synthetic). Malformed JSON rows
 * are counted, never parsed in JS.
 */
function userTurnCounts(db: Database, warnings: WarningCounter, displayName: string): Map<string, number> | null {
	if (!hasColumns(tableColumns(db, 'message'), MESSAGE_COLUMNS)) return null;
	if (!hasColumns(tableColumns(db, 'part'), PART_COLUMNS)) return null;
	try {
		const rows = db
			.prepare(
				`SELECT m.session_id AS sid,
				        SUM(CASE WHEN NOT json_valid(m.data) THEN 0
				                 WHEN json_extract(m.data, '$.role') = 'user' AND EXISTS (
				                   SELECT 1 FROM part p
				                   WHERE p.message_id = m.id AND ${VISIBLE_TEXT_PART})
				                 THEN 1 ELSE 0 END) AS turns,
				        SUM(CASE WHEN json_valid(m.data) THEN 0 ELSE 1 END) AS bad
				 FROM message m GROUP BY m.session_id`
			)
			.all() as Record<string, unknown>[];
		const counts = new Map<string, number>();
		let bad = 0;
		for (const row of rows) {
			const sid = asString(row.sid);
			if (sid) counts.set(sid, asCount(row.turns));
			bad += asCount(row.bad);
		}
		warnings.add('malformed-records', `${displayName} message records with malformed data were skipped`, bad);
		return counts;
	} catch {
		warnings.add('unsupported-schema', `${displayName} turn counts could not be read`);
		return null;
	}
}

function previewDatabase(dbPath: string, nativeId: string, options: PreviewOptions): PreviewMessage[] {
	options.signal?.throwIfAborted();
	const windowSize = Math.min(Math.max(1, options.limit) * 8, 400);
	let db: Database | undefined;
	try {
		db = openReadOnlyDatabase(dbPath);
		if (!hasColumns(tableColumns(db, 'message'), MESSAGE_COLUMNS)) return [];
		if (!hasColumns(tableColumns(db, 'part'), PART_COLUMNS)) return [];
		// The newest messages, then only their text parts; text is extracted in SQL
		// so tool output and file contents never reach JS.
		const rows = db
			.prepare(
				`SELECT m.id AS mid, m.time_created AS at, m.role AS role,
				        json_extract(p.data, '$.text') AS text
				 FROM (SELECT id, time_created,
				              CASE WHEN json_valid(data) THEN json_extract(data, '$.role') END AS role
				       FROM message WHERE session_id = ?
				       ORDER BY time_created DESC, id DESC LIMIT ?) m
				 JOIN part p ON p.message_id = m.id
				 WHERE m.role IN ('user', 'assistant') AND ${VISIBLE_TEXT_PART}
				 ORDER BY m.time_created, m.id, p.id`
			)
			.all(nativeId, windowSize) as Record<string, unknown>[];
		return collectPreview(
			rows.map((row) => ({
				key: String(row.mid),
				role: row.role === 'user' ? 'user' : 'assistant',
				at: msToIso(row.at),
				text: row.text
			})),
			options
		);
	} finally {
		db?.close();
	}
}

async function scanLegacy(config: OpenCodeFamilyConfig, storageDir: string, context: ScanContext): Promise<ScanResult> {
	const { provider, displayName } = config;
	const { cache, signal } = context;
	const warnings = new WarningCounter();
	const listing = await listLegacySessionFiles(storageDir, signal);
	warnings.add('unreadable-file', `${listing.unreadableDirs} ${displayName} session folders could not be read`, listing.unreadableDirs);
	const worktrees = new Map<string, string | null>();
	const byId = new Map<string, DiscoveredSession>();
	let parsedCount = 0;
	let malformed = 0;
	let malformedMessages = 0;
	let unreadable = 0;
	let invalid = 0;

	for (const file of listing.files) {
		signal?.throwIfAborted();
		const fileId = basename(file.path, '.json');
		let fingerprint: { sizeBytes: number; mtimeMs: number };
		try {
			fingerprint = await legacyFingerprint(storageDir, file.path, fileId);
		} catch {
			unreadable++;
			continue;
		}
		const cached = cache.get(file.path);
		if (
			cached &&
			cached.parserVersion === PARSER_VERSION &&
			cached.source.sizeBytes === fingerprint.sizeBytes &&
			cached.source.mtimeMs === fingerprint.mtimeMs &&
			cached.session.provider === provider &&
			isValidNativeId(cached.session.nativeId, provider)
		) {
			if (!byId.has(cached.session.nativeId)) byId.set(cached.session.nativeId, { session: cached.session, source: cached.source });
			continue;
		}

		parsedCount++;
		const facts = await readLegacySession(file.path);
		if (!facts) {
			malformed++;
			continue;
		}
		// Child sessions and archived sessions are hidden by OpenCode's own list.
		if (facts.parentId || facts.archived) continue;
		if (!isValidNativeId(facts.id, provider)) {
			invalid++;
			continue;
		}
		if (byId.has(facts.id)) continue;
		let worktree = worktrees.get(file.projectId);
		if (worktree === undefined) {
			worktree = await readLegacyWorktree(storageDir, file.projectId);
			worktrees.set(file.projectId, worktree);
		}
		const turns = await countLegacyUserTurns(storageDir, facts.id, signal);
		malformedMessages += turns.malformed;
		const title = titleOf(facts.title);
		const lastActivityAt = msToIso(facts.updated);
		byId.set(facts.id, {
			session: {
				id: toSessionId(provider, facts.id),
				provider,
				nativeId: facts.id,
				title,
				titleSource: title ? 'provider-generated' : null,
				projectPath: projectPathOf(facts.directory, worktree),
				latestPath: null,
				startedAt: msToIso(facts.created),
				lastActivityAt: lastActivityAt ?? new Date(fingerprint.mtimeMs).toISOString(),
				lastActivitySource: lastActivityAt ? 'transcript' : 'file-mtime',
				userTurnCount: turns.count
			},
			source: { path: file.path, ...fingerprint }
		});
	}

	warnings.add('malformed-records', `${malformed} ${displayName} session files were malformed`, malformed);
	warnings.add('malformed-records', `${malformedMessages} ${displayName} message files were malformed`, malformedMessages);
	warnings.add('unreadable-file', `${unreadable} ${displayName} session files could not be read`, unreadable);
	warnings.add('malformed-records', `${displayName} sessions with an invalid ID were skipped`, invalid);
	return { sessions: [...byId.values()], warnings: warnings.list(), parsedCount };
}
