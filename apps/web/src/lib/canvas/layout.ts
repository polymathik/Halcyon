import { bounds, CARD_HEIGHT, CARD_WIDTH, type Box, type Point } from './geometry.js';

/** Gutter between cards in a cluster (`space-6`) and between clusters (`space-12`). */
export const CARD_GAP = 24;
export const CLUSTER_GAP = 48;
/** Small groups use up to 3 columns; large groups widen towards a square, capped at 8. */
const BASE_COLUMNS = 3;
const MAX_COLUMNS = 8;
const MIN_ROW_WIDTH = 1600;
/** Vertical gap between existing content and newly placed sessions. */
const NEW_ROW_OFFSET = 96;

export interface LayoutItem {
	id: string;
	/** Grouping key; sessions with the same project are placed together. */
	group: string;
}

/**
 * Positions for sessions that have no saved placement. Items are grouped by
 * project (in the order given, so callers pass most recent first) and each
 * group becomes a grid: up to three columns, widening for large groups (max
 * 8). Groups are shelf-packed into rows about 16:10 overall, below any existing content, so placing new sessions never moves a card
 * the user has already positioned.
 */
export function placeNew(items: LayoutItem[], existing: Box[]): Map<string, Point> {
	const result = new Map<string, Point>();
	if (items.length === 0) return result;

	const groups = new Map<string, string[]>();
	for (const item of items) {
		const list = groups.get(item.group);
		if (list) list.push(item.id);
		else groups.set(item.group, [item.id]);
	}

	const sized = [...groups.values()].map((ids) => {
		const cols = Math.min(ids.length, Math.max(BASE_COLUMNS, Math.min(MAX_COLUMNS, Math.ceil(Math.sqrt(ids.length)))));
		const rows = Math.ceil(ids.length / cols);
		return { ids, cols, width: cols * CARD_WIDTH + (cols - 1) * CARD_GAP, height: rows * CARD_HEIGHT + (rows - 1) * CARD_GAP };
	});
	const totalArea = sized.reduce((sum, g) => sum + (g.width + CLUSTER_GAP) * (g.height + CLUSTER_GAP), 0);

	const area = bounds(existing);
	const originX = area ? area.x : 0;
	let y = area ? area.y + area.h + NEW_ROW_OFFSET : 0;
	const rowWidth = Math.max(MIN_ROW_WIDTH, area?.w ?? 0, Math.sqrt(totalArea * 1.6));

	let x = originX;
	let rowHeight = 0;
	for (const { ids, cols, width, height } of sized) {
		if (x > originX && x + width > originX + rowWidth) {
			x = originX;
			y += rowHeight + CLUSTER_GAP;
			rowHeight = 0;
		}
		ids.forEach((id, i) => {
			result.set(id, {
				x: x + (i % cols) * (CARD_WIDTH + CARD_GAP),
				y: y + Math.floor(i / cols) * (CARD_HEIGHT + CARD_GAP)
			});
		});
		x += width + CLUSTER_GAP;
		rowHeight = Math.max(rowHeight, height);
	}
	return result;
}
