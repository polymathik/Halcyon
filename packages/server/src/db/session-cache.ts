import type { DiscoveredSession, ParseCache, ProviderId, Session } from '@halcyon/core';
import type { Database } from './sqlite.js';

interface CacheRow {
	session_id: string;
	source_path: string;
	source_size: number;
	source_mtime_ms: number;
	parser_version: number;
	metadata_json: string;
}

/**
 * Provider-owned metadata cache. Rows are keyed by session ID and replaced on
 * every successful scan; sessions that disappear are marked missing rather
 * than deleted, so the user's layout for them survives a transient failure.
 */
export class SessionCacheStore {
	constructor(private readonly db: Database) {}

	/** A path-keyed view of one provider's cached rows, for adapter reuse. */
	parseCache(provider: ProviderId): ParseCache {
		const rows = this.db
			.prepare(
				'SELECT session_id, source_path, source_size, source_mtime_ms, parser_version, metadata_json FROM session_cache WHERE provider = ?'
			)
			.all(provider) as unknown as CacheRow[];
		const byPath = new Map(rows.map((row) => [row.source_path, row]));
		return {
			get(path) {
				const row = byPath.get(path);
				if (!row) return undefined;
				return {
					session: JSON.parse(row.metadata_json) as Session,
					source: { path: row.source_path, sizeBytes: row.source_size, mtimeMs: row.source_mtime_ms },
					parserVersion: row.parser_version
				};
			}
		};
	}

	/** Records a successful scan: upserts present sessions and marks absent ones missing. */
	replaceProvider(
		provider: ProviderId,
		parserVersion: number,
		sessions: DiscoveredSession[],
		now = new Date().toISOString()
	): void {
		const upsert = this.db.prepare(`
			INSERT INTO session_cache (session_id, provider, source_path, source_size, source_mtime_ms,
				parser_version, metadata_json, first_seen_at, last_seen_at, missing_since)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
			ON CONFLICT (session_id) DO UPDATE SET
				source_path = excluded.source_path,
				source_size = excluded.source_size,
				source_mtime_ms = excluded.source_mtime_ms,
				parser_version = excluded.parser_version,
				metadata_json = excluded.metadata_json,
				last_seen_at = excluded.last_seen_at,
				missing_since = NULL
		`);
		this.db.exec('BEGIN');
		try {
			for (const { session, source } of sessions) {
				upsert.run(
					session.id,
					provider,
					source.path,
					source.sizeBytes,
					source.mtimeMs,
					parserVersion,
					JSON.stringify(session),
					now,
					now
				);
			}
			const seen = JSON.stringify(sessions.map(({ session }) => session.id));
			this.db
				.prepare(
					`UPDATE session_cache SET missing_since = ?
					 WHERE provider = ? AND missing_since IS NULL
					 AND session_id NOT IN (SELECT value FROM json_each(?))`
				)
				.run(now, provider, seen);
			this.db.exec('COMMIT');
		} catch (error) {
			this.db.exec('ROLLBACK');
			throw error;
		}
	}

	/** Source transcript of a present session, for on-request previews. */
	source(sessionId: string): { provider: ProviderId; path: string } | null {
		const row = this.db
			.prepare('SELECT provider, source_path FROM session_cache WHERE session_id = ? AND missing_since IS NULL')
			.get(sessionId) as { provider: ProviderId; source_path: string } | undefined;
		return row ? { provider: row.provider, path: row.source_path } : null;
	}

	/** Last known present sessions for a provider, used when a scan fails. */
	lastKnown(provider: ProviderId): Session[] {
		const rows = this.db
			.prepare(
				'SELECT metadata_json FROM session_cache WHERE provider = ? AND missing_since IS NULL'
			)
			.all(provider) as unknown as Pick<CacheRow, 'metadata_json'>[];
		return rows.map((row) => JSON.parse(row.metadata_json) as Session);
	}
}
