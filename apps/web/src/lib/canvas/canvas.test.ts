import { describe, expect, it } from 'vitest';
import { bounds, CARD_HEIGHT, CARD_WIDTH, fitCamera, gridPitch, nearestInDirection, toWorld, zoomAt } from './geometry.js';
import { placeNew } from './layout.js';

describe('camera', () => {
	it('zooms toward the anchor point', () => {
		const cam = { x: 100, y: 50, z: 1 };
		const anchor = { x: 400, y: 300 };
		const before = toWorld(cam, anchor);
		const next = zoomAt(cam, 2, anchor);
		expect(next.z).toBe(2);
		expect(toWorld(next, anchor)).toEqual(before);
	});

	it('clamps zoom to 20%–250%', () => {
		expect(zoomAt({ x: 0, y: 0, z: 1 }, 100, { x: 0, y: 0 }).z).toBe(2.5);
		expect(zoomAt({ x: 0, y: 0, z: 1 }, 0.001, { x: 0, y: 0 }).z).toBe(0.2);
	});

	it('fits a box into the view without zooming past 100%', () => {
		const cam = fitCamera({ x: 0, y: 0, w: 200, h: 100 }, { x: 0, y: 44, w: 1000, h: 600 });
		expect(cam.z).toBe(1);
		expect(cam.x).toBe(400);
		expect(cam.y).toBe(44 + 250);
		const small = fitCamera({ x: 0, y: 0, w: 4000, h: 1000 }, { x: 0, y: 0, w: 1000, h: 600 }, 50);
		expect(small.z).toBeCloseTo(900 / 4000);
	});

	it('keeps the dot grid at least 10px apart', () => {
		expect(gridPitch(1)).toBe(16);
		expect(gridPitch(0.5)).toBe(32);
		expect(gridPitch(0.2)).toBeGreaterThanOrEqual(10);
	});
});

describe('keyboard navigation', () => {
	const box = (x: number, y: number) => ({ x, y, w: CARD_WIDTH, h: CARD_HEIGHT });
	const a = box(0, 0);
	const right = box(300, 0);
	const farRightAligned = box(900, 10);
	const below = box(0, 200);
	const all = [a, right, farRightAligned, below];
	it('prefers the aligned neighbour in the direction pressed', () => {
		expect(nearestInDirection(a, all, 'right')).toBe(right);
		expect(nearestInDirection(a, all, 'down')).toBe(below);
		expect(nearestInDirection(a, all, 'left')).toBeNull();
	});
});

describe('auto-layout', () => {
	it('groups by project in up-to-three-column grids, below existing content', () => {
		const existing = [{ x: 100, y: 100, w: CARD_WIDTH, h: CARD_HEIGHT }];
		const placed = placeNew(
			[
				{ id: 'a1', group: 'a' },
				{ id: 'b1', group: 'b' },
				{ id: 'a2', group: 'a' },
				{ id: 'a3', group: 'a' },
				{ id: 'a4', group: 'a' }
			],
			existing
		);
		const a1 = placed.get('a1')!;
		expect(a1.x).toBe(100);
		expect(a1.y).toBeGreaterThan(100 + CARD_HEIGHT);
		expect(placed.get('a2')).toEqual({ x: a1.x + CARD_WIDTH + 24, y: a1.y });
		expect(placed.get('a4')).toEqual({ x: a1.x, y: a1.y + CARD_HEIGHT + 24 });
		const b1 = placed.get('b1')!;
		expect(b1.x).toBeGreaterThan(placed.get('a3')!.x + CARD_WIDTH);
		expect(b1.y).toBe(a1.y);
	});

	it('widens large groups instead of stacking a tall column', () => {
		const items = Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, group: 'one' }));
		const xs = new Set([...placeNew(items, []).values()].map((p) => p.x));
		expect(xs.size).toBe(8);
	});

	it('never overlaps cards it places', () => {
		const items = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, group: `p${i % 9}` }));
		const boxes = [...placeNew(items, []).values()].map((p) => ({ ...p, w: CARD_WIDTH, h: CARD_HEIGHT }));
		for (let i = 0; i < boxes.length; i++)
			for (let j = i + 1; j < boxes.length; j++) {
				const p = boxes[i]!;
				const q = boxes[j]!;
				const overlap = p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
				expect(overlap).toBe(false);
			}
		expect(bounds(boxes)).not.toBeNull();
	});
});
