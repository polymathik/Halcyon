import { describe, expect, it } from 'vitest';
import {
	arrangeZone,
	columnsFor,
	freeSpot,
	intersects,
	projectZoneNames,
	pushDown,
	readingOrder,
	shelfPack,
	zoneColumns,
	zoneWidthFor
} from './arrange.js';
import { CARD_HEIGHT, CARD_HEIGHT_TAGGED, CARD_WIDTH } from './geometry.js';

const zone = { x: 100, y: 100, w: zoneWidthFor(2), h: 150 };

describe('zone grid', () => {
	it('derives columns from width and width from columns', () => {
		for (const cols of [1, 2, 3, 5]) expect(zoneColumns(zoneWidthFor(cols))).toBe(cols);
		expect(zoneColumns(10)).toBe(1);
		expect(columnsFor(1)).toBe(1);
		expect(columnsFor(3)).toBe(3);
		expect(columnsFor(10)).toBe(4);
	});

	it('lays members out without overlap and fits the height', () => {
		const members = [
			{ id: 'a', h: CARD_HEIGHT },
			{ id: 'b', h: CARD_HEIGHT_TAGGED },
			{ id: 'c', h: CARD_HEIGHT }
		];
		const { positions, w, h } = arrangeZone(zone, members);
		expect(w).toBe(zone.w);
		const boxes = members.map((m) => ({ ...positions.get(m.id)!, w: CARD_WIDTH, h: m.h }));
		for (let i = 0; i < boxes.length; i++)
			for (let j = i + 1; j < boxes.length; j++) expect(intersects(boxes[i]!, boxes[j]!)).toBe(false);
		// Two per row; the second row starts below the taller card of the first.
		expect(positions.get('c')!.y).toBeGreaterThanOrEqual(positions.get('a')!.y + CARD_HEIGHT_TAGGED);
		for (const b of boxes) {
			expect(b.x).toBeGreaterThanOrEqual(zone.x);
			expect(b.x + b.w).toBeLessThanOrEqual(zone.x + w);
			expect(b.y + b.h).toBeLessThanOrEqual(zone.y + h);
		}
	});

	it('orders cards by row, then left to right', () => {
		const order = readingOrder(zone, [
			{ id: 'late', x: 500, y: 140 },
			{ id: 'below', x: 110, y: 290 },
			{ id: 'first', x: 110, y: 145 }
		]);
		expect(order).toEqual(['first', 'late', 'below']);
	});
});

describe('overlap handling', () => {
	it('pushes overlapped items down, cascading, and leaves others alone', () => {
		const grown = { id: 'z', x: 0, y: 0, w: 600, h: 400 };
		const shifts = pushDown(grown, [
			{ id: 'under', x: 50, y: 300, w: 300, h: 200 },
			{ id: 'chain', x: 60, y: 520, w: 300, h: 100 },
			{ id: 'beside', x: 900, y: 50, w: 200, h: 200 }
		]);
		expect(shifts.get('under')).toBe(400 + 48 - 300);
		expect(shifts.has('chain')).toBe(true);
		expect(shifts.has('beside')).toBe(false);
	});

	it('finds the nearest free spot', () => {
		const card = { x: 0, y: 0, w: CARD_WIDTH, h: CARD_HEIGHT };
		expect(freeSpot(card, [])).toEqual({ x: 0, y: 0 });
		const spot = freeSpot(card, [{ x: 0, y: 0, w: CARD_WIDTH, h: CARD_HEIGHT }]);
		expect(intersects({ ...spot, w: CARD_WIDTH, h: CARD_HEIGHT }, { x: 0, y: 0, w: CARD_WIDTH, h: CARD_HEIGHT })).toBe(false);
		expect(Math.hypot(spot.x, spot.y)).toBeLessThan(400);
	});

	it('shelf-packs into rows', () => {
		const out = shelfPack([{ w: 500, h: 100 }, { w: 500, h: 300 }, { w: 500, h: 100 }], { x: 0, y: 0 }, 1100);
		expect(out).toEqual([
			{ x: 0, y: 0 },
			{ x: 548, y: 0 },
			{ x: 0, y: 348 }
		]);
	});
});

describe('project zone names', () => {
	it('uses folder names and disambiguates collisions with the parent', () => {
		const names = projectZoneNames(['/w/halcyon', '/a/web', '/b/web', '/c/api']);
		expect(names.get('/w/halcyon')).toBe('halcyon');
		expect(names.get('/a/web')).toBe('web (a)');
		expect(names.get('/b/web')).toBe('web (b)');
		expect(names.get('/c/api')).toBe('api');
	});
});
