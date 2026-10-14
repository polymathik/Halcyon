/**
 * Zone and card arrangement. Pure functions over boxes; the page applies the
 * results to its state and persists them.
 *
 * Model: a zone is a container that lays its cards out in a grid, in reading
 * order, with no overlaps. Its width (set by the user) decides the number of
 * columns; its height always fits its cards.
 */
import {
	CARD_HEIGHT,
	CARD_HEIGHT_TAGGED,
	CARD_WIDTH,
	MIN_ZONE_HEIGHT,
	MIN_ZONE_WIDTH,
	ZONE_LABEL_SPACE,
	ZONE_PAD,
	type Box,
	type Point
} from './geometry.js';

export const ZONE_GAP = 16;
/** Space kept between zones or free cards that get pushed apart. */
export const PUSH_GAP = 48;

export interface Member {
	id: string;
	/** Estimated card height (taller with tags). */
	h: number;
}

export const cardHeightFor = (hasTags: boolean) => (hasTags ? CARD_HEIGHT_TAGGED : CARD_HEIGHT);

/** Columns that fit a zone of this width (at least one). */
export function zoneColumns(width: number): number {
	return Math.max(1, Math.floor((width - ZONE_PAD * 2 + ZONE_GAP) / (CARD_WIDTH + ZONE_GAP)));
}

/** Width of a zone with `cols` columns. */
export function zoneWidthFor(cols: number): number {
	const c = Math.max(1, cols);
	return Math.max(MIN_ZONE_WIDTH, ZONE_PAD * 2 + c * CARD_WIDTH + (c - 1) * ZONE_GAP);
}

/** A sensible column count for a new zone holding `count` cards. */
export function columnsFor(count: number): number {
	if (count <= 3) return Math.max(1, count);
	return Math.min(4, Math.ceil(Math.sqrt(count)));
}

/**
 * Lays members out inside a zone in the given order. Each row is as tall as
 * its tallest card. Returns card positions and the zone's fitted size; the
 * width never shrinks below what the user set, nor below one column.
 */
export function arrangeZone(zone: Box, members: Member[]): { positions: Map<string, Point>; w: number; h: number } {
	const cols = zoneColumns(zone.w);
	const w = Math.max(zone.w, zoneWidthFor(1));
	const positions = new Map<string, Point>();
	let y = zone.y + ZONE_LABEL_SPACE;
	for (let start = 0; start < members.length; start += cols) {
		const row = members.slice(start, start + cols);
		row.forEach((m, i) => positions.set(m.id, { x: zone.x + ZONE_PAD + i * (CARD_WIDTH + ZONE_GAP), y }));
		y += Math.max(...row.map((m) => m.h)) + ZONE_GAP;
	}
	const contentBottom = members.length ? y - ZONE_GAP : zone.y + ZONE_LABEL_SPACE;
	const h = Math.max(MIN_ZONE_HEIGHT, contentBottom - zone.y + ZONE_PAD);
	return { positions, w, h };
}

/**
 * Reading order of cards inside a zone: row bands first, then left to right.
 * A dropped card's drop point places it among the others.
 */
export function readingOrder(zone: Box, cards: (Point & { id: string })[]): string[] {
	const pitch = CARD_HEIGHT_TAGGED + ZONE_GAP;
	const band = (y: number) => Math.round((y - zone.y - ZONE_LABEL_SPACE) / pitch);
	return [...cards].sort((a, b) => band(a.y) - band(b.y) || a.x - b.x).map((c) => c.id);
}

export const intersects = (a: Box, b: Box, pad = 0) =>
	a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

export interface Obstacle extends Box {
	id: string;
}

/**
 * After `changed` grew or moved, pushes anything it now overlaps straight down
 * below it, cascading to whatever those pushes then overlap. Only items that
 * overlap move; the user's layout is otherwise left alone. Returns the vertical
 * shift for each moved item.
 */
export function pushDown(changed: Obstacle, items: Obstacle[], gap = PUSH_GAP): Map<string, number> {
	const shifts = new Map<string, number>();
	const boxes = new Map(items.filter((i) => i.id !== changed.id).map((i) => [i.id, { ...i }]));
	const queue: Obstacle[] = [changed];
	let guard = 0;
	while (queue.length && guard++ < 2000) {
		const mover = queue.shift()!;
		for (const item of boxes.values()) {
			if (item.id === mover.id || !intersects(mover, item)) continue;
			const dy = mover.y + mover.h + gap - item.y;
			if (dy <= 0) continue;
			item.y += dy;
			shifts.set(item.id, (shifts.get(item.id) ?? 0) + dy);
			queue.push(item);
		}
	}
	return shifts;
}

/**
 * The free spot nearest to `card` that overlaps no obstacle (with a little
 * breathing room), searched in growing rings on a 24px grid.
 */
export function freeSpot(card: Box, obstacles: Box[], pad = 12, step = 24): Point {
	const fits = (x: number, y: number) => !obstacles.some((o) => intersects({ x, y, w: card.w, h: card.h }, o, pad));
	if (fits(card.x, card.y)) return { x: card.x, y: card.y };
	for (let ring = 1; ring <= 60; ring++) {
		let best: Point | null = null;
		let bestDistance = Infinity;
		for (let i = -ring; i <= ring; i++) {
			for (const [dx, dy] of [
				[i, -ring],
				[i, ring],
				[-ring, i],
				[ring, i]
			] as const) {
				const x = card.x + dx * step;
				const y = card.y + dy * step;
				const distance = dx * dx + dy * dy;
				if (distance < bestDistance && fits(x, y)) {
					best = { x, y };
					bestDistance = distance;
				}
			}
		}
		if (best) return best;
	}
	return { x: card.x, y: card.y };
}

/** Shelf-packs boxes into rows no wider than `rowWidth`, starting at `origin`. */
export function shelfPack(sizes: { w: number; h: number }[], origin: Point, rowWidth: number, gap = PUSH_GAP): Point[] {
	const out: Point[] = [];
	let x = origin.x;
	let y = origin.y;
	let rowHeight = 0;
	for (const size of sizes) {
		if (x > origin.x && x + size.w > origin.x + rowWidth) {
			x = origin.x;
			y += rowHeight + gap;
			rowHeight = 0;
		}
		out.push({ x, y });
		x += size.w + gap;
		rowHeight = Math.max(rowHeight, size.h);
	}
	return out;
}

/** Row width that packs the given boxes to roughly 16:10. */
export function packWidth(sizes: { w: number; h: number }[], gap = PUSH_GAP): number {
	const area = sizes.reduce((sum, s) => sum + (s.w + gap) * (s.h + gap), 0);
	const widest = Math.max(0, ...sizes.map((s) => s.w));
	return Math.max(1600, widest, Math.sqrt(area * 1.6));
}

/** Short, distinct zone names for project folders: the folder name, plus its parent when names collide. */
export function projectZoneNames(paths: string[]): Map<string, string> {
	const parts = (p: string) => p.split(/[/\\]/).filter(Boolean);
	const base = (p: string) => parts(p).at(-1) ?? p;
	const counts = new Map<string, number>();
	for (const p of paths) counts.set(base(p), (counts.get(base(p)) ?? 0) + 1);
	return new Map(
		paths.map((p) => {
			const name = base(p);
			if ((counts.get(name) ?? 0) < 2) return [p, name];
			const parent = parts(p).at(-2);
			return [p, parent ? `${name} (${parent})` : name];
		})
	);
}
