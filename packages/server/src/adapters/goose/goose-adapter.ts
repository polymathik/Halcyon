import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type {
	DiscoveredSession,
	NativeCommand,
	PreviewMessage,
	PreviewOptions,
	ProviderAdapter,
	ProviderAvailability,
	ScanContext,
	ScanResult,
	Session,
	TitleSource
} from '@halcyon/core';
import { isValidNativeId, toSessionId } from '@halcyon/core';
import { openReadOnlyDatabase, type Database } from '../../db/sqlite.js';
import {
	asBool,
	asCount,
	asString,
	collectPreview,
	epochToIso,
	fileState,
	hasColumns,
	parseSqliteSourcePath,
	sqliteSourcePath,
	sqliteTimeToIso,
	tableColumns,
	WarningCounter
} from '../sqlite-store.js';

const PARSER_VERSION = 1;
const SESSION_COLUMNS = ['id', 'working_dir', 'created_at', 'updated_at'] as const;
const MESSAGE_COLUMNS = ['session_id', 'role', 'content_json', 'created_timestamp'] as const;

/**
 * Names Goose gives a session before one is generated ("CLI Session" in
 * goose-cli, "New Chat" in the desktop app). Only treated as placeholders when
 * the user did not set the name.
 */
const PLACEHOLDER_NAME = /^(CLI Session|New Chat|New session(?: \d+)?)$/i;

export interface GooseAdapterOptions {
	/**
	 * Goose data directory (the one holding `sessions/sessions.db`). Defaults to
	 * `$GOOSE_PATH_ROOT/data` when that is absolute, else the first existing of
	 * `${XDG_DATA_HOME:-~/.local/share}/goose` (Linux and macOS: etcetera's
	 * `choose_app_strategy` uses XDG on macOS), `~/Library/Application
	 * Support/Block/goose` (macOS) and `%APPDATA%\Block\goose\data` (Windows).
	 */
	root?: string;
}

/** Candidate data directories in priority order (crates/goose/src/config/paths.rs). */
export function gooseDataRoots(options: GooseAdapterOptions = {}): string[] {
	if (options.root) return [options.root];
	const pathRoot = process.env.GOOSE_PATH_ROOT;
	if (pathRoot && isAbsolute(pathRoot)) return [join(pathRoot, 'data')];
	const xdg = process.env.XDG_DATA_HOME;
	const roots: string[] = [];
	if (process.platform === 'win32') {
		roots.push(join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Block', 'goose', 'data'));
	} else {
		roots.push(join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.local', 'share'), 'goose'));
		if (process.platform === 'darwin') roots.push(join(homedir(), 'Library', 'Application Support', 'Block', 'goose'));
	}
	return roots;
}

/**
 * Goose (Block) keeps every session in one SQLite database,
 * `<data>/sessions/sessions.db` (session_manager.rs). Lists interactive user
 * sessions only: subagent, hidden, scheduled, terminal, gateway and ACP
 * sessions, child sessions and archived sessions are skipped.
 */
export function createGooseAdapter(options: GooseAdapterOptions = {}): ProviderAdapter {
	const candidates = gooseDataRoots(options).map((root) => resolve(root, 'sessions', 'sessions.db'));

	async function locate(): Promise<{ dbPath: string | null; reason: string }> {
		for (const path of candidates) {
			const state = await fileState(path);
			if (state === 'file') return { dbPath: path, reason: '' };
			if (state !== 'missing') return { dbPath: null, reason: `Goose session database is not readable: ${path}` };
		}
		return { dbPath: null, reason: `No Goose sessions found at ${candidates[0]}` };
	}

	return {
		provider: 'goose',
		displayName: 'Goose',
		parserVersion: PARSER_VERSION,

		async detect(): Promise<ProviderAvailability> {
			const { dbPath, reason } = await locate();
			if (!dbPath) return { available: false, reason };
			let db: Database | undefined;
			try {
				db = openReadOnlyDatabase(dbPath);
				if (!hasColumns(tableColumns(db, 'sessions'), SESSION_COLUMNS)) {
					return { available: false, reason: `Goose session database has an unsupported schema: ${dbPath}` };
				}
				return { available: true, storePath: dbPath };
			} catch {
				return { available: false, reason: `Goose session database could not be opened: ${dbPath}` };
			} finally {
				db?.close();
			}
		},

		async scan(context: ScanContext): Promise<ScanResult> {
			context.signal?.throwIfAborted();
			const { dbPath } = await locate();
			if (!dbPath) return { sessions: [], warnings: [], parsedCount: 0 };
			return scanDatabase(dbPath);
		},

		resumeCommand(session: Session): NativeCommand | null {
			if (session.provider !== 'goose' || !isValidNativeId(session.nativeId, 'goose')) return null;
			// crates/goose-cli/src/cli.rs: `session` with `-r/--resume` and `--session-id`.
			return {
				executable: 'goose',
				args: ['session', '--resume', '--session-id', session.nativeId],
				cwd: session.projectPath && isAbsolute(session.projectPath) ? session.projectPath : null
			};
		},

		async preview(sourcePath: string, previewOptions: PreviewOptions): Promise<PreviewMessage[]> {
			const { dbPath, nativeId } = parseSqliteSourcePath(sourcePath, (path) => candidates.includes(path));
			if (!isValidNativeId(nativeId, 'goose')) throw new Error('Invalid session ID');
			return previewDatabase(dbPath, nativeId, previewOptions);
		}
	};
}

/** `metadata_json.userVisible` is not false; CASE keeps malformed JSON from failing the query. */
const USER_VISIBLE = `AND (CASE WHEN json_valid(metadata_json) THEN COALESCE(json_extract(metadata_json, '$.userVisible'), 1) != 0 ELSE 1 END)`;

/** Message timestamps are seconds, with some rows in milliseconds (session_manager.rs). */
const MESSAGE_SECONDS = `(CASE WHEN created_timestamp > 10000000000 THEN created_timestamp / 1000 ELSE created_timestamp END)`;

function scanDatabase(dbPath: string): ScanResult {
	const warnings = new WarningCounter();
	let db: Database | undefined;
	try {
		db = openReadOnlyDatabase(dbPath);
		const columns = tableColumns(db, 'sessions');
		if (!hasColumns(columns, SESSION_COLUMNS)) {
			warnings.add('unsupported-schema', 'The Goose sessions table is missing required columns');
			return { sessions: [], warnings: warnings.list(), parsedCount: 0 };
		}
		// Older databases predate some columns; filter only on those present.
		const optional = (name: string, fallback = 'NULL') => (columns.has(name) ? name : fallback);
		const filters = [
			columns.has('session_type') ? "(session_type IS NULL OR session_type = 'user')" : null,
			columns.has('parent_session_id') ? 'parent_session_id IS NULL' : null,
			columns.has('archived_at') ? 'archived_at IS NULL' : null
		].filter((clause): clause is string => clause !== null);
		const rows = db
			.prepare(
				`SELECT id, working_dir, created_at, updated_at,
				        ${optional('name')} AS name, ${optional('description')} AS description,
				        ${optional('user_set_name', '0')} AS user_set_name
				 FROM sessions ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}`
			)
			.all() as Record<string, unknown>[];

		const stats = messageStats(db, warnings);
		const sessions: DiscoveredSession[] = [];
		let invalid = 0;
		for (const row of rows) {
			const nativeId = asString(row.id);
			if (!nativeId || !isValidNativeId(nativeId, 'goose')) {
				invalid++;
				continue;
			}
			const userSet = asBool(row.user_set_name);
			// Session.name falls back to the legacy description column (from_row).
			const name = (asString(row.name) ?? asString(row.description))?.trim() || null;
			let title: string | null = null;
			let titleSource: TitleSource | null = null;
			if (name && (userSet || !PLACEHOLDER_NAME.test(name))) {
				title = name;
				titleSource = userSet ? 'custom' : 'provider-generated';
			}
			const stat = stats?.get(nativeId);
			const updated = sqliteTimeToIso(row.updated_at);
			const lastMessage = stat ? epochToIso(stat.last) : null;
			// Goose sorts by the newest message, else the session's updated_at.
			const lastActivityAt = lastMessage && (!updated || lastMessage > updated) ? lastMessage : updated;
			const workingDir = asString(row.working_dir);
			sessions.push({
				session: {
					id: toSessionId('goose', nativeId),
					provider: 'goose',
					nativeId,
					title,
					titleSource,
					projectPath: workingDir && isAbsolute(workingDir) ? workingDir : null,
					latestPath: null,
					startedAt: sqliteTimeToIso(row.created_at),
					lastActivityAt,
					lastActivitySource: lastActivityAt ? 'transcript' : null,
					userTurnCount: stats ? (stat?.turns ?? 0) : null
				},
				source: {
					path: sqliteSourcePath(dbPath, nativeId),
					sizeBytes: 0,
					mtimeMs: lastActivityAt ? Date.parse(lastActivityAt) : 0
				}
			});
		}
		sessions.sort((a, b) => (b.session.lastActivityAt ?? '').localeCompare(a.session.lastActivityAt ?? ''));
		warnings.add('malformed-records', 'Goose sessions with an invalid ID were skipped', invalid);
		return { sessions, warnings: warnings.list(), parsedCount: sessions.length };
	} catch {
		warnings.add('unreadable-file', 'The Goose session database could not be read');
		return { sessions: [], warnings: warnings.list(), parsedCount: 0 };
	} finally {
		db?.close();
	}
}

/**
 * One aggregate over `messages`: the newest message time and the number of
 * user-visible user messages with text. Goose content is
 * `[{"type":"text","text":…}, {"type":"toolResponse",…}, …]`; tool results
 * arrive as user messages without text, and `metadata_json.userVisible=false`
 * marks messages the UI hides.
 */
function messageStats(db: Database, warnings: WarningCounter): Map<string, { last: number; turns: number }> | null {
	const columns = tableColumns(db, 'messages');
	if (!hasColumns(columns, MESSAGE_COLUMNS)) return null;
	const visible = columns.has('metadata_json')
		? USER_VISIBLE
		: '';
	try {
		const rows = db
			.prepare(
				`SELECT session_id AS sid, MAX(${MESSAGE_SECONDS}) AS last,
				        SUM(CASE WHEN role <> 'user' OR NOT json_valid(content_json) THEN 0
				                 WHEN EXISTS (SELECT 1 FROM json_each(content_json) j
				                   WHERE json_extract(j.value, '$.type') = 'text'
				                     AND length(trim(COALESCE(json_extract(j.value, '$.text'), ''))) > 0) ${visible}
				                 THEN 1 ELSE 0 END) AS turns,
				        SUM(CASE WHEN json_valid(content_json) THEN 0 ELSE 1 END) AS bad
				 FROM messages GROUP BY session_id`
			)
			.all() as Record<string, unknown>[];
		const stats = new Map<string, { last: number; turns: number }>();
		let bad = 0;
		for (const row of rows) {
			const sid = asString(row.sid);
			if (sid) stats.set(sid, { last: asCount(row.last), turns: asCount(row.turns) });
			bad += asCount(row.bad);
		}
		warnings.add('malformed-records', 'Goose message records with malformed content were skipped', bad);
		return stats;
	} catch {
		warnings.add('unsupported-schema', 'Goose message statistics could not be read');
		return null;
	}
}

function previewDatabase(dbPath: string, nativeId: string, options: PreviewOptions): PreviewMessage[] {
	options.signal?.throwIfAborted();
	const windowSize = Math.min(Math.max(1, options.limit) * 8, 400);
	let db: Database | undefined;
	try {
		db = openReadOnlyDatabase(dbPath);
		const columns = tableColumns(db, 'messages');
		if (!hasColumns(columns, MESSAGE_COLUMNS)) return [];
		const visible = columns.has('metadata_json')
			? USER_VISIBLE
			: '';
		const order = columns.has('id') ? 'id' : 'rowid';
		const rows = db
			.prepare(
				`SELECT m.rid AS rid, m.role AS role, m.ts AS at, json_extract(j.value, '$.text') AS text
				 FROM (SELECT ${order} AS rid, role, ${MESSAGE_SECONDS} AS ts, content_json FROM messages
				       WHERE session_id = ? AND role IN ('user', 'assistant') AND json_valid(content_json) ${visible}
				       ORDER BY created_timestamp DESC, ${order} DESC LIMIT ?) m, json_each(m.content_json) j
				 WHERE json_extract(j.value, '$.type') = 'text'
				 ORDER BY m.ts, m.rid, j.key`
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
