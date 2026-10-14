import type {
	CardPlacement,
	SessionId,
	Tag,
	Viewport,
	WorkspaceResponse,
	Zone
} from '@halcyon/core';
import type { Database } from './sqlite.js';

export const DEFAULT_WORKSPACE = 'default';

/** User-owned organization: layout and zones per workspace, tags globally. */
export class WorkspaceStore {
	constructor(private readonly db: Database) {}

	get(workspaceId = DEFAULT_WORKSPACE): WorkspaceResponse | null {
		const workspace = this.db
			.prepare('SELECT id, name, viewport_json FROM workspaces WHERE id = ?')
			.get(workspaceId) as { id: string; name: string; viewport_json: string | null } | undefined;
		if (!workspace) return null;

		const placements = this.db
			.prepare(
				'SELECT session_id AS sessionId, x, y, zone_id AS zoneId FROM card_placements WHERE workspace_id = ? ORDER BY session_id'
			)
			.all(workspaceId) as unknown as CardPlacement[];
		const zones = this.db
			.prepare(
				'SELECT id, name, color, x, y, width, height FROM zones WHERE workspace_id = ? ORDER BY id'
			)
			.all(workspaceId) as unknown as Zone[];
		const tags = this.db
			.prepare('SELECT id, name, color FROM tags ORDER BY name')
			.all() as unknown as Tag[];
		const sessionTags = this.db
			.prepare('SELECT session_id AS sessionId, tag_id AS tagId FROM session_tags ORDER BY session_id, tag_id')
			.all() as unknown as { sessionId: SessionId; tagId: number }[];

		return {
			id: workspace.id,
			name: workspace.name,
			viewport: workspace.viewport_json ? (JSON.parse(workspace.viewport_json) as Viewport) : null,
			placements,
			zones,
			tags,
			sessionTags
		};
	}

	setPlacement(
		sessionId: SessionId,
		position: { x: number; y: number },
		workspaceId = DEFAULT_WORKSPACE
	): void {
		this.db
			.prepare(
				`INSERT INTO card_placements (workspace_id, session_id, x, y, zone_id, updated_at)
				 VALUES (?, ?, ?, ?, NULL, ?)
				 ON CONFLICT (workspace_id, session_id) DO UPDATE SET
					x = excluded.x, y = excluded.y, updated_at = excluded.updated_at`
			)
			.run(workspaceId, sessionId, position.x, position.y, new Date().toISOString());
	}

	setViewport(viewport: Viewport, workspaceId = DEFAULT_WORKSPACE): void {
		this.db
			.prepare('UPDATE workspaces SET viewport_json = ? WHERE id = ?')
			.run(JSON.stringify(viewport), workspaceId);
	}
}
