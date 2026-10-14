import type { Database } from './sqlite.js';

/**
 * Ordered schema migrations. Append only; never edit a released entry.
 *
 * Ownership boundaries:
 * - `session_cache` is provider-owned metadata, replaceable on any rescan.
 *   It must never hold transcript text.
 * - `tags`/`session_tags` are user-owned and global across workspaces.
 * - `zones`/`card_placements` are user-owned and scoped to a workspace. A
 *   placement holds a single nullable `zone_id`, so a session is in at most one
 *   zone per workspace by construction.
 */
const MIGRATIONS: string[] = [
	`
	CREATE TABLE workspaces (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		viewport_json TEXT,
		filters_json TEXT,
		created_at TEXT NOT NULL
	);
	INSERT INTO workspaces (id, name, created_at) VALUES ('default', 'Default', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

	CREATE TABLE session_cache (
		session_id TEXT PRIMARY KEY,
		provider TEXT NOT NULL,
		source_path TEXT NOT NULL,
		source_size INTEGER NOT NULL,
		source_mtime_ms REAL NOT NULL,
		parser_version INTEGER NOT NULL,
		metadata_json TEXT NOT NULL,
		first_seen_at TEXT NOT NULL,
		last_seen_at TEXT NOT NULL,
		missing_since TEXT
	);
	CREATE INDEX session_cache_provider ON session_cache (provider);
	CREATE INDEX session_cache_source ON session_cache (source_path);

	CREATE TABLE tags (
		id INTEGER PRIMARY KEY,
		name TEXT NOT NULL UNIQUE COLLATE NOCASE,
		color TEXT
	);

	CREATE TABLE session_tags (
		session_id TEXT NOT NULL,
		tag_id INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
		PRIMARY KEY (session_id, tag_id)
	);

	CREATE TABLE zones (
		id INTEGER PRIMARY KEY,
		workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
		name TEXT NOT NULL,
		color TEXT NOT NULL,
		x REAL NOT NULL,
		y REAL NOT NULL,
		width REAL NOT NULL CHECK (width > 0),
		height REAL NOT NULL CHECK (height > 0),
		created_at TEXT NOT NULL
	);

	CREATE TABLE card_placements (
		workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
		session_id TEXT NOT NULL,
		x REAL NOT NULL,
		y REAL NOT NULL,
		zone_id INTEGER REFERENCES zones (id) ON DELETE SET NULL,
		updated_at TEXT NOT NULL,
		PRIMARY KEY (workspace_id, session_id)
	);

	-- A placement may only reference a zone from its own workspace.
	CREATE TRIGGER card_placements_zone_workspace_insert
	BEFORE INSERT ON card_placements
	WHEN NEW.zone_id IS NOT NULL
		AND (SELECT workspace_id FROM zones WHERE id = NEW.zone_id) IS NOT NEW.workspace_id
	BEGIN
		SELECT RAISE(ABORT, 'zone belongs to a different workspace');
	END;
	CREATE TRIGGER card_placements_zone_workspace_update
	BEFORE UPDATE OF zone_id, workspace_id ON card_placements
	WHEN NEW.zone_id IS NOT NULL
		AND (SELECT workspace_id FROM zones WHERE id = NEW.zone_id) IS NOT NEW.workspace_id
	BEGIN
		SELECT RAISE(ABORT, 'zone belongs to a different workspace');
	END;
	`,
	`
	-- User-owned display names. Halcyon never writes to provider transcripts.
	CREATE TABLE session_titles (
		session_id TEXT PRIMARY KEY,
		title TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);
	-- A zone created for a project folder; new sessions from it join the zone.
	ALTER TABLE zones ADD COLUMN project_path TEXT;
	`,
	`
	-- A collapsed zone shows only its label; its cards are hidden, not moved.
	ALTER TABLE zones ADD COLUMN collapsed INTEGER NOT NULL DEFAULT 0;
	`,
	`
	-- Sessions the user archived in Halcyon. Provider files are never touched.
	CREATE TABLE session_archive (
		session_id TEXT PRIMARY KEY,
		archived_at TEXT NOT NULL
	);
	`
];

export function migrate(db: Database): number {
	const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
	const current = row.user_version;
	if (current > MIGRATIONS.length) {
		throw new Error(
			`Halcyon database schema version ${current} is newer than this release supports (${MIGRATIONS.length}).`
		);
	}
	for (let version = current; version < MIGRATIONS.length; version++) {
		db.exec('BEGIN');
		try {
			db.exec(MIGRATIONS[version]!);
			db.exec(`PRAGMA user_version = ${version + 1}`);
			db.exec('COMMIT');
		} catch (error) {
			db.exec('ROLLBACK');
			throw error;
		}
	}
	return MIGRATIONS.length;
}
