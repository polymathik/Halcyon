import {
	MAX_TAGS_PER_SESSION,
	ZONE_COLORS,
	type CardPlacement,
	type SavedFilter,
	type SessionId,
	type Tag,
	type TagsResponse,
	type Viewport,
	type WorkspaceResponse,
	type Zone,
	type ZoneColor,
	type ZoneInput
} from '@halcyon/core';
import type { Database } from './sqlite.js';

export const DEFAULT_WORKSPACE = 'default';

export class NotFoundError extends Error {}

export interface PlacementInput {
	sessionId: SessionId;
	x: number;
	y: number;
	/** Omitted keeps the current zone; null removes the session from its zone. */
	zoneId?: number | null;
}

/** User-owned organization: layout and zones per workspace, tags globally. */
export class WorkspaceStore {
	constructor(private readonly db: Database) {}

	get(workspaceId = DEFAULT_WORKSPACE): WorkspaceResponse | null {
		const workspace = this.db
			.prepare('SELECT id, name, viewport_json, filters_json FROM workspaces WHERE id = ?')
			.get(workspaceId) as
			| { id: string; name: string; viewport_json: string | null; filters_json: string | null }
			| undefined;
		if (!workspace) return null;

		const placements = this.db
			.prepare(
				'SELECT session_id AS sessionId, x, y, zone_id AS zoneId FROM card_placements WHERE workspace_id = ? ORDER BY session_id'
			)
			.all(workspaceId) as unknown as CardPlacement[];
		const zones = (
			this.db
				.prepare('SELECT id, name, color, x, y, width, height FROM zones WHERE workspace_id = ? ORDER BY id')
				.all(workspaceId) as unknown as Zone[]
		).map((zone) => ({ ...zone, color: asZoneColor(zone.color) }));

		return {
			id: workspace.id,
			name: workspace.name,
			viewport: workspace.viewport_json ? (JSON.parse(workspace.viewport_json) as Viewport) : null,
			placements,
			zones,
			...this.tagState(),
			filter: workspace.filters_json ? (JSON.parse(workspace.filters_json) as SavedFilter) : null
		};
	}

	setPlacement(sessionId: SessionId, position: { x: number; y: number; zoneId?: number | null }, workspaceId = DEFAULT_WORKSPACE): void {
		this.setPlacements([{ sessionId, ...position }], workspaceId);
	}

	/**
	 * Writes several placements in one transaction. Zone IDs must belong to the
	 * workspace; an unknown zone rejects the whole batch.
	 */
	setPlacements(placements: PlacementInput[], workspaceId = DEFAULT_WORKSPACE): void {
		const now = new Date().toISOString();
		const keepZone = this.db.prepare(
			`INSERT INTO card_placements (workspace_id, session_id, x, y, zone_id, updated_at)
			 VALUES (?, ?, ?, ?, NULL, ?)
			 ON CONFLICT (workspace_id, session_id) DO UPDATE SET
				x = excluded.x, y = excluded.y, updated_at = excluded.updated_at`
		);
		const withZone = this.db.prepare(
			`INSERT INTO card_placements (workspace_id, session_id, x, y, zone_id, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (workspace_id, session_id) DO UPDATE SET
				x = excluded.x, y = excluded.y, zone_id = excluded.zone_id, updated_at = excluded.updated_at`
		);
		this.transaction(() => {
			for (const p of placements) {
				if (p.zoneId === undefined) keepZone.run(workspaceId, p.sessionId, p.x, p.y, now);
				else {
					if (p.zoneId !== null) this.requireZone(p.zoneId, workspaceId);
					withZone.run(workspaceId, p.sessionId, p.x, p.y, p.zoneId, now);
				}
			}
		});
	}

	setViewport(viewport: Viewport, workspaceId = DEFAULT_WORKSPACE): void {
		this.db.prepare('UPDATE workspaces SET viewport_json = ? WHERE id = ?').run(JSON.stringify(viewport), workspaceId);
	}

	setFilter(filter: SavedFilter | null, workspaceId = DEFAULT_WORKSPACE): void {
		this.db
			.prepare('UPDATE workspaces SET filters_json = ? WHERE id = ?')
			.run(filter && filter.tags.length ? JSON.stringify(filter) : null, workspaceId);
	}

	// ---------- zones ----------

	createZone(input: ZoneInput, workspaceId = DEFAULT_WORKSPACE): Zone {
		const result = this.db
			.prepare(
				'INSERT INTO zones (workspace_id, name, color, x, y, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
			)
			.run(workspaceId, input.name, input.color, input.x, input.y, input.width, input.height, new Date().toISOString());
		return { id: Number(result.lastInsertRowid), ...input };
	}

	updateZone(id: number, changes: Partial<ZoneInput>, workspaceId = DEFAULT_WORKSPACE): Zone {
		const zone = this.requireZone(id, workspaceId);
		const next = { ...zone, ...changes };
		this.db
			.prepare('UPDATE zones SET name = ?, color = ?, x = ?, y = ?, width = ?, height = ? WHERE id = ? AND workspace_id = ?')
			.run(next.name, next.color, next.x, next.y, next.width, next.height, id, workspaceId);
		return next;
	}

	/** Deletes a zone; its cards stay where they are, outside any zone. */
	deleteZone(id: number, workspaceId = DEFAULT_WORKSPACE): void {
		this.requireZone(id, workspaceId);
		this.db.prepare('DELETE FROM zones WHERE id = ? AND workspace_id = ?').run(id, workspaceId);
	}

	// ---------- tags ----------

	/** Replaces a session's tags (already normalized). Unused tags are removed. */
	setSessionTags(sessionId: SessionId, names: string[]): TagsResponse {
		const unique = [...new Set(names)].slice(0, MAX_TAGS_PER_SESSION);
		this.transaction(() => {
			this.db.prepare('DELETE FROM session_tags WHERE session_id = ?').run(sessionId);
			const insertTag = this.db.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT (name) DO NOTHING');
			const findTag = this.db.prepare('SELECT id FROM tags WHERE name = ?');
			const link = this.db.prepare('INSERT OR IGNORE INTO session_tags (session_id, tag_id) VALUES (?, ?)');
			for (const name of unique) {
				insertTag.run(name);
				const row = findTag.get(name) as { id: number };
				link.run(sessionId, row.id);
			}
			this.db.exec('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM session_tags)');
		});
		return this.tagState();
	}

	private tagState(): TagsResponse {
		const tags = this.db.prepare('SELECT id, name, color FROM tags ORDER BY name').all() as unknown as Tag[];
		const sessionTags = this.db
			.prepare('SELECT session_id AS sessionId, tag_id AS tagId FROM session_tags ORDER BY session_id, tag_id')
			.all() as unknown as { sessionId: SessionId; tagId: number }[];
		return { tags, sessionTags };
	}

	private requireZone(id: number, workspaceId: string): Zone {
		const zone = this.db
			.prepare('SELECT id, name, color, x, y, width, height FROM zones WHERE id = ? AND workspace_id = ?')
			.get(id, workspaceId) as Zone | undefined;
		if (!zone) throw new NotFoundError(`Zone ${id} not found`);
		return { ...zone, color: asZoneColor(zone.color) };
	}

	private transaction(work: () => void): void {
		this.db.exec('BEGIN');
		try {
			work();
			this.db.exec('COMMIT');
		} catch (error) {
			this.db.exec('ROLLBACK');
			throw error;
		}
	}
}

function asZoneColor(value: string): ZoneColor {
	return (ZONE_COLORS as readonly string[]).includes(value) ? (value as ZoneColor) : 'slate';
}
