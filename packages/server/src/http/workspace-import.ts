import {
	MAX_TAGS_PER_SESSION,
	MAX_TITLE_LENGTH,
	MAX_WORKSPACE_NAME,
	normalizeTag,
	parseSessionId,
	WORKSPACE_EXPORT_FORMAT,
	ZONE_COLORS,
	type SavedFilter,
	type SessionId,
	type Viewport,
	type WorkspaceExport,
	type ZoneColor
} from '@halcyon/core';

const MAX_COORDINATE = 10_000_000;
const MAX_ZONES = 500;
const MAX_ENTRIES = 20_000;
const MAX_ZONE_NAME = 80;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const coordinate = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORDINATE;
const size = (v: unknown): v is number => coordinate(v) && v >= 40;
const cleanText = (v: unknown, max: number): string | null => {
	if (typeof v !== 'string') return null;
	const text = v.trim();
	return text && text.length <= max && !/[\u0000-\u001f]/.test(text) ? text : null;
};
const list = (v: unknown, max: number): unknown[] | null => (Array.isArray(v) && v.length <= max ? v : null);

/**
 * Validates an uploaded workspace export field by field. The file comes from
 * the user's disk, so nothing in it is trusted: unknown keys are dropped,
 * invalid entries are skipped and counted, and only a wrong format or version,
 * or a missing name, rejects the whole file.
 */
export function parseWorkspaceExport(raw: Record<string, unknown> | null): { data: WorkspaceExport; skipped: number } | null {
	if (!raw || raw.format !== WORKSPACE_EXPORT_FORMAT || raw.version !== 1) return null;
	const name = cleanText(raw.name, MAX_WORKSPACE_NAME);
	if (!name) return null;
	let skipped = 0;

	let viewport: Viewport | null = null;
	if (isObject(raw.viewport)) {
		const { x, y, zoom } = raw.viewport;
		if (coordinate(x) && coordinate(y) && typeof zoom === 'number' && zoom > 0 && zoom <= 10) viewport = { x, y, zoom };
		else skipped++;
	}

	let filter: SavedFilter | null = null;
	if (isObject(raw.filter)) {
		const tags = list(raw.filter.tags, 50)?.map((t) => (typeof t === 'string' ? normalizeTag(t) : null));
		const mode = raw.filter.mode;
		if (tags && tags.every((t) => t) && (mode === 'highlight' || mode === 'only')) filter = { tags: [...new Set(tags as string[])], mode };
		else skipped++;
	}

	const zones: WorkspaceExport['zones'] = [];
	const refs = new Set<number>();
	for (const z of list(raw.zones, MAX_ZONES) ?? []) {
		const zoneName = isObject(z) ? cleanText(z.name, MAX_ZONE_NAME) : null;
		if (
			!isObject(z) ||
			!zoneName ||
			!Number.isInteger(z.ref) ||
			refs.has(z.ref as number) ||
			!(ZONE_COLORS as readonly unknown[]).includes(z.color) ||
			!coordinate(z.x) ||
			!coordinate(z.y) ||
			!size(z.width) ||
			!size(z.height)
		) {
			skipped++;
			continue;
		}
		const projectPath = typeof z.projectPath === 'string' && z.projectPath.length > 0 && z.projectPath.length <= 4096 ? z.projectPath : null;
		refs.add(z.ref as number);
		zones.push({
			ref: z.ref as number,
			name: zoneName,
			color: z.color as ZoneColor,
			x: z.x,
			y: z.y,
			width: z.width,
			height: z.height,
			projectPath,
			collapsed: z.collapsed === true
		});
	}

	const session = (v: unknown): SessionId | null => parseSessionId(v)?.id ?? null;
	const placements: WorkspaceExport['placements'] = [];
	const placed = new Set<string>();
	for (const p of list(raw.placements, MAX_ENTRIES) ?? []) {
		const id = isObject(p) ? session(p.sessionId) : null;
		if (!isObject(p) || !id || placed.has(id) || !coordinate(p.x) || !coordinate(p.y)) {
			skipped++;
			continue;
		}
		placed.add(id);
		const zone = Number.isInteger(p.zone) && refs.has(p.zone as number) ? (p.zone as number) : null;
		placements.push({ sessionId: id, x: p.x, y: p.y, zone });
	}

	const tags: WorkspaceExport['tags'] = [];
	for (const t of list(raw.tags, MAX_ENTRIES) ?? []) {
		const id = isObject(t) ? session(t.sessionId) : null;
		const names = isObject(t) ? list(t.tags, MAX_TAGS_PER_SESSION)?.map((n) => (typeof n === 'string' ? normalizeTag(n) : null)) : null;
		if (!id || !names || !names.every((n) => n)) {
			skipped++;
			continue;
		}
		tags.push({ sessionId: id, tags: [...new Set(names as string[])] });
	}

	const titles: WorkspaceExport['titles'] = [];
	for (const t of list(raw.titles, MAX_ENTRIES) ?? []) {
		const id = isObject(t) ? session(t.sessionId) : null;
		const title = isObject(t) ? cleanText(t.title, MAX_TITLE_LENGTH) : null;
		if (!id || !title) {
			skipped++;
			continue;
		}
		titles.push({ sessionId: id, title });
	}

	const archived: SessionId[] = [];
	for (const a of list(raw.archived, MAX_ENTRIES) ?? []) {
		const id = session(a);
		if (id) archived.push(id);
		else skipped++;
	}

	return {
		data: {
			format: WORKSPACE_EXPORT_FORMAT,
			version: 1,
			exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt.slice(0, 40) : new Date().toISOString(),
			name,
			viewport,
			filter,
			zones,
			placements,
			tags,
			titles,
			archived: [...new Set(archived)]
		},
		skipped
	};
}
