import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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
import {
	asCount,
	asString,
	collectPreview,
	epochToIso,
	fileState,
	hasColumns,
	parseSqliteSourcePath,
	sqliteSourcePath,
	tableColumns,
	WarningCounter
} from '../sqlite-store.js';

const PARSER_VERSION = 1;
const SESSION_COLUMNS = ['id', 'parent_session_id', 'title', 'created_at', 'updated_at'] as const;
const MESSAGE_COLUMNS = ['session_id', 'role', 'parts', 'created_at'] as const;

/**
 * Crush's placeholder titles: "New Session" (UI, internal/ui/model/ui.go) and
 * agent.DefaultSessionName "Untitled Session", used until or instead of a
 * generated title.
 */
const PLACEHOLDER_TITLES = new Set(['New Session', 'Untitled Session']);

export interface CrushAdapterOptions {
	/**
	 * Crush global data directory holding `projects.json`. Defaults to
	 * `$CRUSH_GLOBAL_DATA`, then `$XDG_DATA_HOME/crush`, then
	 * `%LOCALAPPDATA%\crush` on Windows or `~/.local/share/crush`
	 * (config.GlobalConfigData in internal/config/load.go).
	 */
	root?: string;
}

export function crushDataRoot(options: CrushAdapterOptions = {}): string {
	if (options.root) return options.root;
	if (process.env.CRUSH_GLOBAL_DATA) return process.env.CRUSH_GLOBAL_DATA;
	if (process.env.XDG_DATA_HOME) return join(process.env.XDG_DATA_HOME, 'crush');
	if (process.platform === 'win32') {
		const local = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || homedir(), 'AppData', 'Local');
		return join(local, 'crush');
	}
	return join(homedir(), '.local', 'share', 'crush');
}

/** One Crush database and the project directory its sessions belong to. */
interface CrushStore {
	dbPath: string;
	dataDir: string;
	projectPath: string;
}

type Registry = { ok: true; stores: CrushStore[]; skipped: number } | { ok: false; reason: 'missing' | 'unreadable' | 'malformed' };

/**
 * Reads `projects.json` (internal/projects/projects.go:
 * `{"projects":[{"path","data_dir","last_accessed"}]}`, most recent first).
 * Several projects can share one data dir, because Crush uses the closest
 * `.crush` folder above the working directory; such a database is listed
 * once, under the project that owns the folder when it is registered, else the
 * most recently used one.
 */
async function loadRegistry(registryPath: string): Promise<Registry> {
	let text: string;
	try {
		text = await readFile(registryPath, 'utf8');
	} catch (error) {
		return { ok: false, reason: (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unreadable' };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { ok: false, reason: 'malformed' };
	}
	const projects = (parsed as { projects?: unknown } | null)?.projects;
	if (!Array.isArray(projects)) return { ok: false, reason: 'malformed' };

	const byDb = new Map<string, CrushStore>();
	let skipped = 0;
	for (const entry of projects) {
		const path = asString((entry as { path?: unknown } | null)?.path);
		const dataDir = asString((entry as { data_dir?: unknown } | null)?.data_dir);
		if (!path || !dataDir || !isAbsolute(path) || !isAbsolute(dataDir)) {
			skipped++;
			continue;
		}
		const store: CrushStore = { dbPath: join(resolve(dataDir), 'crush.db'), dataDir: resolve(dataDir), projectPath: resolve(path) };
		const existing = byDb.get(store.dbPath);
		if (!existing) byDb.set(store.dbPath, store);
		else if (dirname(store.dataDir) === store.projectPath && dirname(existing.dataDir) !== existing.projectPath) {
			byDb.set(store.dbPath, store);
		}
	}
	return { ok: true, stores: [...byDb.values()], skipped };
}

/**
 * Crush keeps one SQLite database per project (`<project>/.crush/crush.db`).
 * Halcyon opens only databases listed in Crush's own project registry; it
 * never searches the filesystem for them.
 */
export function createCrushAdapter(options: CrushAdapterOptions = {}): ProviderAdapter {
	const root = crushDataRoot(options);
	const registryPath = join(root, 'projects.json');
	/** Data dir per session from the last scan, to pass `-D` when it is not the default. */
	const dataDirs = new Map<string, string>();

	return {
		provider: 'crush',
		displayName: 'Crush',
		parserVersion: PARSER_VERSION,

		async detect(): Promise<ProviderAvailability> {
			const registry = await loadRegistry(registryPath);
			if (registry.ok) return { available: true, storePath: registryPath };
			if (registry.reason === 'missing') return { available: false, reason: `No Crush projects found at ${registryPath}` };
			return { available: false, reason: `Crush project registry is not readable: ${registryPath}` };
		},

		async scan(context: ScanContext): Promise<ScanResult> {
			context.signal?.throwIfAborted();
			const warnings = new WarningCounter();
			const registry = await loadRegistry(registryPath);
			if (!registry.ok) {
				warnings.add('unreadable-file', 'The Crush project registry could not be read');
				return { sessions: [], warnings: warnings.list(), parsedCount: 0 };
			}
			warnings.add('malformed-records', `${registry.skipped} Crush project registry entries were malformed`, registry.skipped);

			const byId = new Map<string, DiscoveredSession>();
			let missing = 0;
			let duplicates = 0;
			dataDirs.clear();
			for (const store of registry.stores) {
				context.signal?.throwIfAborted();
				const state = await fileState(store.dbPath);
				if (state === 'missing') {
					missing++;
					continue;
				}
				if (state !== 'file') {
					warnings.add('unreadable-file', 'Crush project databases could not be read');
					continue;
				}
				for (const discovered of scanStore(store, warnings)) {
					if (byId.has(discovered.session.nativeId)) {
						duplicates++;
						continue;
					}
					byId.set(discovered.session.nativeId, discovered);
					dataDirs.set(discovered.session.nativeId, store.dataDir);
				}
			}
			warnings.add('unreadable-file', `${missing} registered Crush projects have no database`, missing);
			warnings.add('index-mismatch', `${duplicates} Crush sessions appear in more than one project database`, duplicates);
			const sessions = [...byId.values()];
			return { sessions, warnings: warnings.list(), parsedCount: sessions.length };
		},

		resumeCommand(session: Session): NativeCommand | null {
			if (session.provider !== 'crush' || !isValidNativeId(session.nativeId, 'crush')) return null;
			if (!session.projectPath || !isAbsolute(session.projectPath)) return null;
			// internal/cmd/root.go: -c/--cwd, -D/--data-dir, -s/--session.
			const args = ['-c', session.projectPath];
			const dataDir = dataDirs.get(session.nativeId);
			if (dataDir && dataDir !== join(session.projectPath, '.crush')) args.push('-D', dataDir);
			args.push('-s', session.nativeId);
			return { executable: 'crush', args, cwd: session.projectPath };
		},

		async preview(sourcePath: string, previewOptions: PreviewOptions): Promise<PreviewMessage[]> {
			const registry = await loadRegistry(registryPath);
			const owned = new Set(registry.ok ? registry.stores.map((store) => store.dbPath) : []);
			const { dbPath, nativeId } = parseSqliteSourcePath(sourcePath, (path) => owned.has(path));
			if (!isValidNativeId(nativeId, 'crush')) throw new Error('Invalid session ID');
			return previewStore(dbPath, nativeId, previewOptions);
		}
	};
}

function titleOf(title: string | null): string | null {
	return title && !PLACEHOLDER_TITLES.has(title.trim()) ? title : null;
}

function scanStore(store: CrushStore, warnings: WarningCounter): DiscoveredSession[] {
	let db: Database | undefined;
	try {
		db = openReadOnlyDatabase(store.dbPath);
		if (!hasColumns(tableColumns(db, 'sessions'), SESSION_COLUMNS)) {
			warnings.add('unsupported-schema', 'Crush project databases with an unsupported schema were skipped');
			return [];
		}
		// sessions.sql ListSessions: top-level sessions only. Task and
		// title-generation sessions carry a parent_session_id.
		const rows = db
			.prepare(
				`SELECT id, title, created_at, updated_at FROM sessions
				 WHERE parent_session_id IS NULL ORDER BY updated_at DESC`
			)
			.all() as Record<string, unknown>[];
		const turns = userTurnCounts(db, warnings);
		const sessions: DiscoveredSession[] = [];
		let invalid = 0;
		for (const row of rows) {
			const nativeId = asString(row.id);
			if (!nativeId || !isValidNativeId(nativeId, 'crush')) {
				invalid++;
				continue;
			}
			const title = titleOf(asString(row.title));
			const lastActivityAt = epochToIso(row.updated_at);
			sessions.push({
				session: {
					id: toSessionId('crush', nativeId),
					provider: 'crush',
					nativeId,
					title,
					titleSource: title ? 'provider-generated' : null,
					projectPath: store.projectPath,
					latestPath: null,
					startedAt: epochToIso(row.created_at),
					lastActivityAt,
					lastActivitySource: lastActivityAt ? 'transcript' : null,
					userTurnCount: turns ? (turns.get(nativeId) ?? 0) : null
				},
				source: {
					path: sqliteSourcePath(store.dbPath, nativeId),
					sizeBytes: 0,
					mtimeMs: lastActivityAt ? Date.parse(lastActivityAt) : 0
				}
			});
		}
		warnings.add('malformed-records', 'Crush sessions with an invalid ID were skipped', invalid);
		return sessions;
	} catch {
		warnings.add('unreadable-file', 'Crush project databases could not be read');
		return [];
	} finally {
		db?.close();
	}
}

/**
 * User messages with at least one visible text part. Crush stores parts as
 * `[{"type":"text","data":{"text":…,"hidden":bool}}, …]` (internal/message);
 * `hidden` marks generated continuations.
 */
function userTurnCounts(db: Database, warnings: WarningCounter): Map<string, number> | null {
	if (!hasColumns(tableColumns(db, 'messages'), MESSAGE_COLUMNS)) return null;
	try {
		const rows = db
			.prepare(
				`SELECT session_id AS sid,
				        SUM(CASE WHEN role <> 'user' OR NOT json_valid(parts) THEN 0
				                 WHEN EXISTS (SELECT 1 FROM json_each(parts) j
				                   WHERE json_extract(j.value, '$.type') = 'text'
				                     AND COALESCE(json_extract(j.value, '$.data.hidden'), 0) = 0
				                     AND length(trim(COALESCE(json_extract(j.value, '$.data.text'), ''))) > 0)
				                 THEN 1 ELSE 0 END) AS turns,
				        SUM(CASE WHEN json_valid(parts) THEN 0 ELSE 1 END) AS bad
				 FROM messages GROUP BY session_id`
			)
			.all() as Record<string, unknown>[];
		const counts = new Map<string, number>();
		let bad = 0;
		for (const row of rows) {
			const sid = asString(row.sid);
			if (sid) counts.set(sid, asCount(row.turns));
			bad += asCount(row.bad);
		}
		warnings.add('malformed-records', 'Crush message records with malformed parts were skipped', bad);
		return counts;
	} catch {
		warnings.add('unsupported-schema', 'Crush turn counts could not be read');
		return null;
	}
}

function previewStore(dbPath: string, nativeId: string, options: PreviewOptions): PreviewMessage[] {
	options.signal?.throwIfAborted();
	const windowSize = Math.min(Math.max(1, options.limit) * 8, 400);
	let db: Database | undefined;
	try {
		db = openReadOnlyDatabase(dbPath);
		if (!hasColumns(tableColumns(db, 'messages'), MESSAGE_COLUMNS)) return [];
		// created_at has one-second resolution; rowid keeps insertion order.
		const rows = db
			.prepare(
				`SELECT m.rid AS rid, m.role AS role, m.created_at AS at,
				        json_extract(j.value, '$.data.text') AS text
				 FROM (SELECT rowid AS rid, role, created_at, parts FROM messages
				       WHERE session_id = ? AND role IN ('user', 'assistant') AND json_valid(parts)
				       ORDER BY created_at DESC, rowid DESC LIMIT ?) m, json_each(m.parts) j
				 WHERE json_extract(j.value, '$.type') = 'text'
				   AND COALESCE(json_extract(j.value, '$.data.hidden'), 0) = 0
				 ORDER BY m.created_at, m.rid, j.key`
			)
			.all(nativeId, windowSize) as Record<string, unknown>[];
		return collectPreview(
			rows.map((row) => ({
				key: String(row.rid),
				role: row.role === 'user' ? 'user' : 'assistant',
				at: epochToIso(row.at),
				text: row.text
			})),
			options
		);
	} finally {
		db?.close();
	}
}
