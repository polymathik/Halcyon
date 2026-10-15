import { randomBytes } from 'node:crypto';
import {
	MAX_TAGS_PER_SESSION,
	MAX_WORKSPACES,
	WORKSPACE_EXPORT_FORMAT,
	type WorkspaceExport,
	type WorkspaceSummary,
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
/** A request that conflicts with the current state (limit reached, default workspace). */
export class ConflictError extends Error {}

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
				.prepare(
					'SELECT id, name, color, x, y, width, height, project_path AS projectPath, collapsed FROM zones WHERE workspace_id = ? ORDER BY id'
				)
				.all(workspaceId) as unknown as RawZone[]
		).map(toZone);
		const titles = this.db
			.prepare('SELECT session_id AS sessionId, title FROM session_titles ORDER BY session_id')
			.all() as unknown as { sessionId: SessionId; title: string }[];

		return {
			id: workspace.id,
			name: workspace.name,
			viewport: workspace.viewport_json ? (JSON.parse(workspace.viewport_json) as Viewport) : null,
			placements,
			zones,
			...this.tagState(),
			titles,
			archived: (this.db.prepare('SELECT session_id FROM session_archive ORDER BY session_id').all() as { session_id: SessionId }[]).map(
				(row) => row.session_id
			),
			filter: workspace.filters_json ? (JSON.parse(workspace.filters_json) as SavedFilter) : null
		};
	}

	// ---------- workspaces ----------

	list(): WorkspaceSummary[] {
		const rows = this.db
			.prepare(
				`SELECT w.id, w.name, w.created_at AS createdAt,
					(SELECT COUNT(*) FROM card_placements p WHERE p.workspace_id = w.id) AS cardCount,
					(SELECT COUNT(*) FROM zones z WHERE z.workspace_id = w.id) AS zoneCount
				 FROM workspaces w
				 ORDER BY w.id = ? DESC, w.created_at, w.id`
			)
			.all(DEFAULT_WORKSPACE) as { id: string; name: string; createdAt: string; cardCount: number; zoneCount: number }[];
		return rows.map((row) => ({ ...row, cardCount: Number(row.cardCount), zoneCount: Number(row.zoneCount), isDefault: row.id === DEFAULT_WORKSPACE }));
	}

	exists(workspaceId: string): boolean {
		return !!this.db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(workspaceId);
	}

	/**
	 * Creates a workspace, empty or as a copy of another one's layout (zones,
	 * placements, viewport, filter). Tags, names and archive state are shared.
	 */
	createWorkspace(name: string, copyFrom?: string): WorkspaceSummary {
		const count = (this.db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number }).n;
		if (Number(count) >= MAX_WORKSPACES) throw new ConflictError(`At most ${MAX_WORKSPACES} workspaces`);
		if (copyFrom !== undefined && !this.exists(copyFrom)) throw new NotFoundError('Workspace not found');
		const id = `ws_${randomBytes(6).toString('hex')}`;
		this.transaction(() => {
			this.db
				.prepare('INSERT INTO workspaces (id, name, viewport_json, filters_json, created_at) VALUES (?, ?, ?, ?, ?)')
				.run(id, this.uniqueName(name), null, null, new Date().toISOString());
			if (copyFrom !== undefined) this.copyLayout(copyFrom, id);
		});
		return this.summary(id);
	}

	renameWorkspace(workspaceId: string, name: string): WorkspaceSummary {
		if (!this.exists(workspaceId)) throw new NotFoundError('Workspace not found');
		this.db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(this.uniqueName(name, workspaceId), workspaceId);
		return this.summary(workspaceId);
	}

	/** Deletes a workspace's layout and zones. Sessions, tags and names are untouched. */
	deleteWorkspace(workspaceId: string): void {
		if (workspaceId === DEFAULT_WORKSPACE) throw new ConflictError('The default workspace cannot be deleted');
		if (!this.exists(workspaceId)) throw new NotFoundError('Workspace not found');
		this.transaction(() => {
			this.db.prepare('DELETE FROM card_placements WHERE workspace_id = ?').run(workspaceId);
			this.db.prepare('DELETE FROM zones WHERE workspace_id = ?').run(workspaceId);
			this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
		});
	}

	exportWorkspace(workspaceId: string): WorkspaceExport {
		const workspace = this.get(workspaceId);
		if (!workspace) throw new NotFoundError('Workspace not found');
		const tagNames = new Map(workspace.tags.map((t) => [t.id, t.name]));
		const tagsBySession = new Map<SessionId, string[]>();
		for (const { sessionId, tagId } of workspace.sessionTags) {
			const name = tagNames.get(tagId);
			if (name) tagsBySession.set(sessionId, [...(tagsBySession.get(sessionId) ?? []), name]);
		}
		return {
			format: WORKSPACE_EXPORT_FORMAT,
			version: 1,
			exportedAt: new Date().toISOString(),
			name: workspace.name,
			viewport: workspace.viewport,
			filter: workspace.filter,
			zones: workspace.zones.map((z) => ({
				ref: z.id,
				name: z.name,
				color: z.color,
				x: z.x,
				y: z.y,
				width: z.width,
				height: z.height,
				projectPath: z.projectPath,
				collapsed: z.collapsed
			})),
			placements: workspace.placements.map((p) => ({ sessionId: p.sessionId, x: p.x, y: p.y, zone: p.zoneId })),
			tags: [...tagsBySession].map(([sessionId, tags]) => ({ sessionId, tags })),
			titles: workspace.titles,
			archived: workspace.archived
		};
	}

	/**
	 * Imports an already-validated export as a new workspace. Shared state is
	 * merged without overwriting: tags are added, a display name is set only
	 * where none exists, and archived sessions stay archived.
	 */
	importWorkspace(data: WorkspaceExport): WorkspaceSummary {
		const count = (this.db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number }).n;
		if (Number(count) >= MAX_WORKSPACES) throw new ConflictError(`At most ${MAX_WORKSPACES} workspaces`);
		const id = `ws_${randomBytes(6).toString('hex')}`;
		const now = new Date().toISOString();
		this.transaction(() => {
			this.db
				.prepare('INSERT INTO workspaces (id, name, viewport_json, filters_json, created_at) VALUES (?, ?, ?, ?, ?)')
				.run(
					id,
					this.uniqueName(data.name),
					data.viewport ? JSON.stringify(data.viewport) : null,
					data.filter && data.filter.tags.length ? JSON.stringify(data.filter) : null,
					now
				);
			const insertZone = this.db.prepare(
				'INSERT INTO zones (workspace_id, name, color, x, y, width, height, project_path, collapsed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
			);
			const zoneIds = new Map<number, number>();
			for (const z of data.zones) {
				const result = insertZone.run(id, z.name, z.color, z.x, z.y, z.width, z.height, z.projectPath ?? null, z.collapsed ? 1 : 0, now);
				zoneIds.set(z.ref, Number(result.lastInsertRowid));
			}
			const place = this.db.prepare(
				'INSERT OR REPLACE INTO card_placements (workspace_id, session_id, x, y, zone_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
			);
			for (const p of data.placements) {
				place.run(id, p.sessionId, p.x, p.y, p.zone === null ? null : (zoneIds.get(p.zone) ?? null), now);
			}
			const insertTag = this.db.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT (name) DO NOTHING');
			const findTag = this.db.prepare('SELECT id FROM tags WHERE name = ?');
			const countTags = this.db.prepare('SELECT COUNT(*) AS n FROM session_tags WHERE session_id = ?');
			const link = this.db.prepare('INSERT OR IGNORE INTO session_tags (session_id, tag_id) VALUES (?, ?)');
			for (const { sessionId, tags } of data.tags) {
				for (const name of tags) {
					if (Number((countTags.get(sessionId) as { n: number }).n) >= MAX_TAGS_PER_SESSION) break;
					insertTag.run(name);
					link.run(sessionId, (findTag.get(name) as { id: number }).id);
				}
			}
			const setTitle = this.db.prepare('INSERT OR IGNORE INTO session_titles (session_id, title, updated_at) VALUES (?, ?, ?)');
			for (const t of data.titles) setTitle.run(t.sessionId, t.title, now);
			const archive = this.db.prepare('INSERT OR IGNORE INTO session_archive (session_id, archived_at) VALUES (?, ?)');
			for (const sessionId of data.archived) archive.run(sessionId, now);
		});
		return this.summary(id);
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
		const projectPath = input.projectPath ?? null;
		const collapsed = input.collapsed ?? false;
		const result = this.db
			.prepare(
				'INSERT INTO zones (workspace_id, name, color, x, y, width, height, project_path, collapsed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
			)
			.run(workspaceId, input.name, input.color, input.x, input.y, input.width, input.height, projectPath, collapsed ? 1 : 0, new Date().toISOString());
		return { id: Number(result.lastInsertRowid), ...input, projectPath, collapsed };
	}

	updateZone(id: number, changes: Partial<ZoneInput>, workspaceId = DEFAULT_WORKSPACE): Zone {
		const zone = this.requireZone(id, workspaceId);
		const next = { ...zone, ...changes };
		this.db
			.prepare(
				'UPDATE zones SET name = ?, color = ?, x = ?, y = ?, width = ?, height = ?, project_path = ?, collapsed = ? WHERE id = ? AND workspace_id = ?'
			)
			.run(next.name, next.color, next.x, next.y, next.width, next.height, next.projectPath ?? null, next.collapsed ? 1 : 0, id, workspaceId);
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

	/** Sets or clears (null) the display name a user gave a session in Halcyon. */
	setSessionTitle(sessionId: SessionId, title: string | null): void {
		if (title === null) {
			this.db.prepare('DELETE FROM session_titles WHERE session_id = ?').run(sessionId);
			return;
		}
		this.db
			.prepare(
				`INSERT INTO session_titles (session_id, title, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT (session_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`
			)
			.run(sessionId, title, new Date().toISOString());
	}

	/** Archives or restores sessions in Halcyon. Provider files are never touched. */
	setArchived(sessionIds: SessionId[], archived: boolean): void {
		const now = new Date().toISOString();
		const add = this.db.prepare('INSERT OR IGNORE INTO session_archive (session_id, archived_at) VALUES (?, ?)');
		const remove = this.db.prepare('DELETE FROM session_archive WHERE session_id = ?');
		this.transaction(() => {
			for (const id of sessionIds) {
				if (archived) add.run(id, now);
				else remove.run(id);
			}
		});
	}

	private summary(workspaceId: string): WorkspaceSummary {
		const found = this.list().find((w) => w.id === workspaceId);
		if (!found) throw new NotFoundError('Workspace not found');
		return found;
	}

	/** The name, or "name (2)", "name (3)"… when another workspace already uses it. */
	private uniqueName(name: string, exceptId?: string): string {
		const taken = new Set(
			(this.db.prepare('SELECT id, name FROM workspaces').all() as { id: string; name: string }[])
				.filter((w) => w.id !== exceptId)
				.map((w) => w.name.toLowerCase())
		);
		if (!taken.has(name.toLowerCase())) return name;
		for (let n = 2; ; n++) {
			const candidate = `${name} (${n})`;
			if (!taken.has(candidate.toLowerCase())) return candidate;
		}
	}

	private copyLayout(from: string, to: string): void {
		const source = this.db.prepare('SELECT viewport_json, filters_json FROM workspaces WHERE id = ?').get(from) as {
			viewport_json: string | null;
			filters_json: string | null;
		};
		this.db.prepare('UPDATE workspaces SET viewport_json = ?, filters_json = ? WHERE id = ?').run(source.viewport_json, source.filters_json, to);
		const zones = this.db
			.prepare('SELECT id, name, color, x, y, width, height, project_path, collapsed, created_at FROM zones WHERE workspace_id = ? ORDER BY id')
			.all(from) as { id: number; name: string; color: string; x: number; y: number; width: number; height: number; project_path: string | null; collapsed: number; created_at: string }[];
		const insertZone = this.db.prepare(
			'INSERT INTO zones (workspace_id, name, color, x, y, width, height, project_path, collapsed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
		);
		const map = new Map<number, number>();
		for (const z of zones) {
			const result = insertZone.run(to, z.name, z.color, z.x, z.y, z.width, z.height, z.project_path, z.collapsed, z.created_at);
			map.set(z.id, Number(result.lastInsertRowid));
		}
		const placements = this.db
			.prepare('SELECT session_id, x, y, zone_id FROM card_placements WHERE workspace_id = ?')
			.all(from) as { session_id: string; x: number; y: number; zone_id: number | null }[];
		const insert = this.db.prepare(
			'INSERT INTO card_placements (workspace_id, session_id, x, y, zone_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
		);
		const now = new Date().toISOString();
		for (const p of placements) insert.run(to, p.session_id, p.x, p.y, p.zone_id === null ? null : (map.get(p.zone_id) ?? null), now);
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
			.prepare(
				'SELECT id, name, color, x, y, width, height, project_path AS projectPath, collapsed FROM zones WHERE id = ? AND workspace_id = ?'
			)
			.get(id, workspaceId) as RawZone | undefined;
		if (!zone) throw new NotFoundError(`Zone ${id} not found`);
		return toZone(zone);
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

type RawZone = Omit<Zone, 'collapsed' | 'color'> & { color: string; collapsed: number };

function toZone(row: RawZone): Zone {
	return { ...row, color: asZoneColor(row.color), collapsed: row.collapsed === 1 };
}

function asZoneColor(value: string): ZoneColor {
	return (ZONE_COLORS as readonly string[]).includes(value) ? (value as ZoneColor) : 'slate';
}
