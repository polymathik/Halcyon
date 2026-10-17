/** Camera and geometry for the canvas. Pure functions; no DOM access. */

export interface Camera {
	/** Screen-space offset of world origin, in CSS px. */
	x: number;
	y: number;
	/** Scale; 1 = 100%. */
	z: number;
}

export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface Point {
	x: number;
	y: number;
}

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 2.5;
/** Below this zoom, cards switch to the compact level of detail. */
export const COMPACT_BELOW = 0.55;
/** At or above this zoom cards show repository and branch in place of the plain folder path. */
export const DETAIL_FROM = 1.25;
export const CARD_WIDTH = 248;
/** Card height estimates (cards are content-sized): without tags ~90px, with tags ~118px. */
export const CARD_HEIGHT = 96;
export const CARD_HEIGHT_TAGGED = 124;

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Screen point (relative to the viewport) to world coordinates. */
export function toWorld(cam: Camera, screen: Point): Point {
	return { x: (screen.x - cam.x) / cam.z, y: (screen.y - cam.y) / cam.z };
}

/** Zoom by `factor`, keeping the world point under `anchor` (viewport px) fixed. */
export function zoomAt(cam: Camera, factor: number, anchor: Point): Camera {
	const z = clampZoom(cam.z * factor);
	const k = z / cam.z;
	return { x: anchor.x - (anchor.x - cam.x) * k, y: anchor.y - (anchor.y - cam.y) * k, z };
}

export function bounds(boxes: Box[]): Box | null {
	if (boxes.length === 0) return null;
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const b of boxes) {
		x0 = Math.min(x0, b.x);
		y0 = Math.min(y0, b.y);
		x1 = Math.max(x1, b.x + b.w);
		y1 = Math.max(y1, b.y + b.h);
	}
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Camera that fits `box` inside the visible area `view` (viewport px, already
 * excluding chrome and the sidebar), never zooming in past `maxZoom`.
 */
export function fitCamera(box: Box, view: Box, pad = 64, maxZoom = 1): Camera {
	const w = Math.max(1, box.w);
	const h = Math.max(1, box.h);
	const z = clampZoom(Math.min(maxZoom, (view.w - pad * 2) / w, (view.h - pad * 2) / h));
	return {
		z,
		x: view.x + (view.w - w * z) / 2 - box.x * z,
		y: view.y + (view.h - h * z) / 2 - box.y * z
	};
}

/** Camera that centres world point `p` in `view` at zoom `z`. */
export function centreOn(p: Point, view: Box, z: number): Camera {
	return { z, x: view.x + view.w / 2 - p.x * z, y: view.y + view.h / 2 - p.y * z };
}

/** Dot-grid pitch: 16px at 100%, multiplied by 4 whenever dots would be closer than 10px. */
export function gridPitch(z: number): number {
	let pitch = 16 * z;
	while (pitch < 10) pitch *= 4;
	return pitch;
}

/** Text counter-scale for compact cards so titles stay legible when zoomed out. */
export function lodScale(z: number): number {
	// Quantized so continuous zooming restyles cards a few times, not every frame.
	return Math.round(Math.min(COMPACT_BELOW / z, 2.4) * 5) / 5;
}

export type Direction = 'left' | 'right' | 'up' | 'down';

/**
 * The nearest box in a direction from `from`, favouring alignment: distance
 * along the direction plus 2.5x the sideways offset. Null when none lies that way.
 */
export function nearestInDirection<T extends Box>(from: Box, candidates: T[], direction: Direction): T | null {
	const [dx, dy] = { right: [1, 0], left: [-1, 0], down: [0, 1], up: [0, -1] }[direction] as [number, number];
	const cx = from.x + from.w / 2;
	const cy = from.y + from.h / 2;
	let best: T | null = null;
	let bestScore = Infinity;
	for (const c of candidates) {
		if (c === from) continue;
		const ox = c.x + c.w / 2 - cx;
		const oy = c.y + c.h / 2 - cy;
		const along = ox * dx + oy * dy;
		if (along <= 1) continue;
		const across = Math.abs(ox * dy) + Math.abs(oy * dx);
		const score = along + across * 2.5;
		if (score < bestScore) {
			bestScore = score;
			best = c;
		}
	}
	return best;
}

/** Inner clearance when a card snaps into a zone: 16px, and 40px under the label. */
export const ZONE_PAD = 16;
export const ZONE_LABEL_SPACE = 40;
export const MIN_ZONE_WIDTH = 200;
export const MIN_ZONE_HEIGHT = 120;

export function contains(box: Box, p: Point): boolean {
	return p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
}

/**
 * Drop rule: the card is clamped inside the zone with clearance, and the zone
 * grows when it is too small to hold the card. Returns both new rectangles.
 */
export function snapIntoZone(card: Box, zone: Box): { card: Point; zone: Box } {
	const w = Math.max(zone.w, card.w + ZONE_PAD * 2);
	const h = Math.max(zone.h, card.h + ZONE_LABEL_SPACE + ZONE_PAD);
	const x = Math.min(Math.max(card.x, zone.x + ZONE_PAD), zone.x + w - card.w - ZONE_PAD);
	const y = Math.min(Math.max(card.y, zone.y + ZONE_LABEL_SPACE), zone.y + h - card.h - ZONE_PAD);
	return { card: { x: Math.round(x), y: Math.round(y) }, zone: { x: zone.x, y: zone.y, w, h } };
}

/** Smallest size a zone may be resized to: it must still hold its cards. */
export function minZoneSize(zone: Box, members: Box[]): { w: number; h: number } {
	const b = bounds(members);
	if (!b) return { w: MIN_ZONE_WIDTH, h: MIN_ZONE_HEIGHT };
	return {
		w: Math.max(MIN_ZONE_WIDTH, b.x + b.w - zone.x + ZONE_PAD),
		h: Math.max(MIN_ZONE_HEIGHT, b.y + b.h - zone.y + ZONE_PAD)
	};
}

/** Grid slots inside a zone for `count` cards, up to `columns` wide. */
export function zoneGrid(origin: Point, count: number, columns: number, gap = 16): { slots: Point[]; w: number; h: number } {
	const cols = Math.max(1, Math.min(columns, count));
	const rows = Math.max(1, Math.ceil(count / cols));
	const slots = Array.from({ length: count }, (_, i) => ({
		x: origin.x + ZONE_PAD + (i % cols) * (CARD_WIDTH + gap),
		y: origin.y + ZONE_LABEL_SPACE + Math.floor(i / cols) * (CARD_HEIGHT + gap + 24)
	}));
	return {
		slots,
		w: Math.max(MIN_ZONE_WIDTH, ZONE_PAD * 2 + cols * CARD_WIDTH + (cols - 1) * gap),
		h: Math.max(MIN_ZONE_HEIGHT, ZONE_LABEL_SPACE + ZONE_PAD + rows * (CARD_HEIGHT + 24) + (rows - 1) * gap)
	};
}

/** Height of a zone collapsed to its label. */
export const COLLAPSED_ZONE_HEIGHT = 40;
/** Width of a zone collapsed to its label (never wider than the zone itself). */
export const COLLAPSED_ZONE_WIDTH = 240;
