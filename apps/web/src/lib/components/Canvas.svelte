<script lang="ts">
	import type { Session, Zone as ZoneModel } from '@halcyon/core';
	import type { SvelteMap } from 'svelte/reactivity';
	import {
		bounds,
		CARD_HEIGHT,
		CARD_HEIGHT_TAGGED,
		CARD_WIDTH,
		centreOn,
		COMPACT_BELOW,
		contains,
		fitCamera,
		gridPitch,
		lodScale,
		nearestInDirection,
		toWorld,
		zoomAt,
		type Box,
		type Camera,
		type Direction,
		type Point
	} from '#lib/canvas/geometry.js';
	import { zoneWidthFor } from '#lib/canvas/arrange.js';
	import Icon from './Icon.svelte';
	import Minimap from './Minimap.svelte';
	import SessionCard from './SessionCard.svelte';
	import Zone from './Zone.svelte';

	export interface FilterView {
		tags: string[];
		mode: 'highlight' | 'only';
		/** Sessions matching any of `tags`. */
		matches: Set<string>;
	}

	interface Props {
		sessions: Session[];
		positions: SvelteMap<string, Point>;
		zones: SvelteMap<number, ZoneModel>;
		zoneOf: SvelteMap<string, number | null>;
		tagsOf: SvelteMap<string, string[]>;
		/** Display names given in Halcyon. */
		titlesOf: SvelteMap<string, string>;
		renamingSession: string | null;
		filter: FilterView | null;
		selectedId: string | null;
		renamingZone: number | null;
		sideOpen: boolean;
		now: number;
		initialCamera: Camera | null;
		scrollZooms: boolean;
		gridOn: boolean;
		onselect: (id: string | null) => void;
		/** A card was dropped at `position`; `zoneId` is the zone under the pointer (null for open canvas). */
		onmoved: (id: string, position: Point, zoneId: number | null, previousZone: number | null) => void;
		/** A zone's width changed during a resize; the page re-lays out its cards. */
		onzonereflow: (zoneId: number) => void;
		onrenamesessionstart: (id: string) => void;
		onrenamesession: (id: string, title: string | null) => void;
		/** Zone geometry changed (moved with its members, resized, or grown by a drop). */
		onzonechanged: (zoneId: number, movedMembers: boolean) => void;
		onzonerename: (zoneId: number, name: string | null) => void;
		onzonerenamestart: (zoneId: number) => void;
		onzonedelete: (zoneId: number) => void;
		onnewzone: (centre: Point) => void;
		onescape: () => void;
		onfocusfilter: () => void;
		oncamera: (camera: Camera) => void;
	}
	let {
		sessions,
		positions,
		zones,
		zoneOf,
		tagsOf,
		titlesOf,
		renamingSession,
		filter,
		selectedId,
		renamingZone,
		sideOpen,
		now,
		initialCamera,
		scrollZooms,
		gridOn,
		onselect,
		onmoved,
		onzonereflow,
		onrenamesessionstart,
		onrenamesession,
		onzonechanged,
		onzonerename,
		onzonerenamestart,
		onzonedelete,
		onnewzone,
		onescape,
		onfocusfilter,
		oncamera
	}: Props = $props();

	const TOPBAR = 44;
	/** Sidebar width plus its 8px inset on both sides. */
	const SIDEBAR_SPACE = 380 + 16;
	const GLIDE_MS = 220;

	let vp: HTMLElement;
	let vw = $state(0);
	let vh = $state(0);

	// ---------- camera: one transform on one layer, written once per frame ----------
	// svelte-ignore state_referenced_locally
	let cam = $state.raw<Camera>(initialCamera ?? { x: 0, y: 0, z: 1 });
	let pending: Camera | null = null;
	let frame = 0;
	let glide = 0;

	function current(): Camera {
		return pending ?? cam;
	}
	function setCam(next: Camera) {
		cancelAnimationFrame(glide);
		pending = next;
		if (!frame)
			frame = requestAnimationFrame(() => {
				frame = 0;
				if (pending) cam = pending;
				pending = null;
			});
	}
	const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
	function glideTo(target: Camera, ms = GLIDE_MS) {
		cancelAnimationFrame(glide);
		cancelAnimationFrame(frame);
		frame = 0;
		pending = null;
		if (reducedMotion() || ms <= 0) {
			cam = target;
			return;
		}
		const from = cam;
		const start = performance.now();
		const step = (t: number) => {
			const u = Math.min(1, (t - start) / ms);
			const e = 1 - Math.pow(1 - u, 3);
			cam = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, z: from.z + (target.z - from.z) * e };
			if (u < 1) glide = requestAnimationFrame(step);
		};
		glide = requestAnimationFrame(step);
	}

	const compact = $derived(cam.z < COMPACT_BELOW);
	const lod = $derived(compact ? lodScale(cam.z).toFixed(2) : '1');
	const pitch = $derived(gridPitch(cam.z));
	const zoomLabel = $derived(`${Math.round(cam.z * 100)}%`);

	/** The part of the viewport not covered by the top bar or the sidebar. */
	function visibleArea(withSidebar = sideOpen): Box {
		const side = withSidebar && vw > 760 ? SIDEBAR_SPACE : 0;
		return { x: 0, y: TOPBAR, w: Math.max(1, vw - side), h: Math.max(1, vh - TOPBAR) };
	}

	// ---------- dot grid ----------
	// Drawn on a canvas: repainting a full-screen CSS gradient on every zoom step
	// cost 50–80ms frames with 200+ cards; a canvas redraw is about a millisecond.
	let gridEl = $state<HTMLCanvasElement>();
	let dotColor = '#d6dadf';
	function readDotColor() {
		if (gridEl) dotColor = getComputedStyle(gridEl).getPropertyValue('--canvas-dot').trim() || dotColor;
	}
	function drawGrid() {
		const el = gridEl;
		if (!el || vw === 0 || vh === 0) return;
		const dpr = window.devicePixelRatio || 1;
		const w = Math.round(vw * dpr);
		const h = Math.round(vh * dpr);
		if (el.width !== w || el.height !== h) {
			el.width = w;
			el.height = h;
		}
		const ctx = el.getContext('2d');
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, vw, vh);
		if (!gridOn) return;
		const p = pitch;
		const ox = ((cam.x % p) + p) % p;
		const oy = ((cam.y % p) + p) % p;
		ctx.globalAlpha = cam.z < 0.35 ? 0.6 : 1;
		ctx.fillStyle = dotColor;
		ctx.beginPath();
		for (let x = ox; x < vw + p; x += p) {
			for (let y = oy; y < vh + p; y += p) {
				ctx.moveTo(x + 2, y + 1);
				ctx.arc(x + 1, y + 1, 1, 0, Math.PI * 2);
			}
		}
		ctx.fill();
	}
	$effect(() => {
		// Redraw when the camera, size, grid preference or theme changes.
		void cam;
		void vw;
		void vh;
		void gridOn;
		drawGrid();
	});
	$effect(() => {
		readDotColor();
		const redraw = () => {
			readDotColor();
			drawGrid();
		};
		const observer = new MutationObserver(redraw);
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
		const media = matchMedia('(prefers-color-scheme: dark)');
		media.addEventListener('change', redraw);
		return () => {
			observer.disconnect();
			media.removeEventListener('change', redraw);
		};
	});

	// ---------- items ----------
	const placed = $derived(
		sessions.flatMap((session) => {
			const p = positions.get(session.id);
			if (!p) return [];
			const tags = tagsOf.get(session.id) ?? [];
			const match = !filter || filter.matches.has(session.id);
			return [{ session, x: p.x, y: p.y, tags, match }];
		})
	);
	const cardHeight = (id: string) => ((tagsOf.get(id)?.length ?? 0) > 0 ? CARD_HEIGHT_TAGGED : CARD_HEIGHT);
	const visible = $derived(placed.filter((item) => item.match || filter?.mode !== 'only'));
	const boxes = $derived(visible.map(({ session, x, y }) => ({ id: session.id, x, y, w: CARD_WIDTH, h: cardHeight(session.id) })));
	const zoneList = $derived([...zones.values()]);
	const zoneBox = (z: ZoneModel): Box => ({ x: z.x, y: z.y, w: z.width, h: z.height });
	const memberCount = $derived.by(() => {
		const present = new Set<string>(sessions.map((s) => s.id));
		const counts = new Map<number, number>();
		for (const [id, zone] of zoneOf) if (zone !== null && present.has(id)) counts.set(zone, (counts.get(zone) ?? 0) + 1);
		return counts;
	});
	const members = (zoneId: number) => [...zoneOf].filter(([, z]) => z === zoneId).map(([id]) => id);

	// ---------- public actions ----------
	export function fitAll(animate = true) {
		const b = bounds([...boxes, ...zoneList.map(zoneBox)]);
		if (!b) return;
		const target = fitCamera(b, visibleArea());
		if (animate) glideTo(target);
		else cam = target;
	}
	export function fitBox(box: Box) {
		glideTo(fitCamera(box, visibleArea(), 80));
	}
	export function focusOn(id: string) {
		const p = positions.get(id);
		if (!p) return;
		const z = Math.max(current().z, 0.9);
		glideTo(centreOn({ x: p.x + CARD_WIDTH / 2, y: p.y + cardHeight(id) / 2 }, visibleArea(true), z));
	}
	export function zoomBy(factor: number) {
		const v = visibleArea();
		glideTo(zoomAt(current(), factor, { x: v.x + v.w / 2, y: v.y + v.h / 2 }), 120);
	}
	export function resetZoom() {
		const v = visibleArea();
		const centre = toWorld(current(), { x: v.x + v.w / 2, y: v.y + v.h / 2 });
		glideTo(centreOn(centre, v, 1));
	}
	/** World point at the centre of the visible area. */
	export function viewCentre(): Point {
		const v = visibleArea();
		return toWorld(current(), { x: v.x + v.w / 2, y: v.y + v.h / 2 });
	}
	/** Bounds of everything on the canvas, for placing new zones beside it. */
	export function contentBounds(): Box | null {
		return bounds([...placed.map(({ session, x, y }) => ({ x, y, w: CARD_WIDTH, h: cardHeight(session.id) })), ...zoneList.map(zoneBox)]);
	}

	// Cards may arrive a tick after mount (first auto-placement), so wait for them.
	let initialised = false;
	$effect(() => {
		if (initialised || vw === 0 || vh === 0) return;
		if (!initialCamera && boxes.length === 0 && zoneList.length === 0) return;
		initialised = true;
		if (!initialCamera) fitAll(false);
	});

	// Persist the camera after it settles.
	$effect(() => {
		const snapshot = cam;
		if (!initialised) return;
		const timer = setTimeout(() => oncamera(snapshot), 800);
		return () => clearTimeout(timer);
	});

	// ---------- pointer: pan, drag cards, move/resize zones ----------
	type Action =
		| { kind: 'pan'; sx: number; sy: number; cx: number; cy: number; moved: boolean }
		| { kind: 'card'; id: string; ox: number; oy: number; sx: number; sy: number; moved: boolean }
		| { kind: 'zone'; id: number; sx: number; sy: number; zx: number; zy: number; members: [string, Point][]; moved: boolean }
		| { kind: 'resize'; id: number; sx: number; sy: number; w: number; h: number; moved: boolean };
	let action: Action | null = null;
	let dragId = $state<string | null>(null);
	let dropZone = $state<number | null>(null);
	let panning = $state(false);
	let spaceHeld = $state(false);

	function local(event: { clientX: number; clientY: number }): Point {
		const r = vp.getBoundingClientRect();
		return { x: event.clientX - r.left, y: event.clientY - r.top };
	}
	function zoneAt(p: Point): ZoneModel | undefined {
		return [...zoneList].reverse().find((z) => contains(zoneBox(z), p));
	}

	function onpointerdown(event: PointerEvent) {
		const target = event.target as HTMLElement;
		if (target.closest('.chrome, input')) return;
		cancelAnimationFrame(glide);
		const card = target.closest<HTMLElement>('.hc-card');
		const zoneEl = target.closest<HTMLElement>('.hc-zone');
		const onLabel = !!target.closest('.hc-zone__label');
		const onHandle = !!target.closest('.hc-zone__handle');
		const onMenu = target.closest<HTMLElement>('[data-action]');

		if (onMenu && zoneEl && event.button === 0) {
			// Keep focus where it lands (the rename field), not on the button.
			event.preventDefault();
			const id = Number(zoneEl.dataset.zone);
			if (onMenu.dataset.action === 'delete-zone') onzonedelete(id);
			else if (onMenu.dataset.action === 'rename-zone') onzonerenamestart(id);
			return;
		}
		// Empty canvas or a zone body pans; so do the middle button and Space.
		if (event.button === 1 || spaceHeld || (event.button === 0 && !card && !onLabel && !onHandle)) {
			const c = current();
			action = { kind: 'pan', sx: event.clientX, sy: event.clientY, cx: c.x, cy: c.y, moved: false };
			panning = true;
			vp.setPointerCapture(event.pointerId);
			if (event.button === 1) event.preventDefault();
			return;
		}
		if (event.button !== 0) return;
		const w = toWorld(current(), local(event));
		if (card) {
			const id = card.dataset.id!;
			const p = positions.get(id);
			if (!p) return;
			action = { kind: 'card', id, ox: w.x - p.x, oy: w.y - p.y, sx: event.clientX, sy: event.clientY, moved: false };
		} else if (zoneEl) {
			const id = Number(zoneEl.dataset.zone);
			const zone = zones.get(id);
			if (!zone) return;
			action = onHandle
				? { kind: 'resize', id, sx: event.clientX, sy: event.clientY, w: zone.width, h: zone.height, moved: false }
				: {
						kind: 'zone',
						id,
						sx: event.clientX,
						sy: event.clientY,
						zx: zone.x,
						zy: zone.y,
						members: members(id).flatMap((m) => {
							const p = positions.get(m);
							return p ? [[m, { ...p }] as [string, Point]] : [];
						}),
						moved: false
					};
		} else return;
		vp.setPointerCapture(event.pointerId);
	}

	function onpointermove(event: PointerEvent) {
		if (!action) return;
		const dx = event.clientX - action.sx;
		const dy = event.clientY - action.sy;
		if (action.kind === 'pan') {
			if (Math.abs(dx) + Math.abs(dy) > 2) action.moved = true;
			setCam({ ...current(), x: action.cx + dx, y: action.cy + dy });
			return;
		}
		if (!action.moved) {
			if (Math.abs(dx) + Math.abs(dy) < 4) return;
			action.moved = true;
			if (action.kind === 'card') dragId = action.id;
		}
		const k = 1 / current().z;
		// Drags track the pointer on the same frame: no easing.
		if (action.kind === 'card') {
			const w = toWorld(current(), local(event));
			positions.set(action.id, { x: Math.round(w.x - action.ox), y: Math.round(w.y - action.oy) });
			dropZone = zoneAt(w)?.id ?? null;
		} else if (action.kind === 'zone') {
			const zone = zones.get(action.id);
			if (!zone) return;
			const mx = Math.round(dx * k);
			const my = Math.round(dy * k);
			zones.set(action.id, { ...zone, x: action.zx + mx, y: action.zy + my });
			for (const [id, p] of action.members) positions.set(id, { x: p.x + mx, y: p.y + my });
		} else {
			const zone = zones.get(action.id);
			if (!zone) return;
			// Width sets the columns; the page re-lays out the cards and fits the height.
			const width = Math.round(Math.max(zoneWidthFor(1), action.w + dx * k));
			if (width !== zone.width) {
				zones.set(action.id, { ...zone, width });
				onzonereflow(action.id);
			}
		}
	}

	// Double-clicks are detected here rather than with dblclick events: pointer
	// capture retargets those to the canvas, so they never reach a zone label.
	let lastTap: { key: string; t: number; x: number; y: number } | null = null;
	function isDoubleTap(key: string, event: PointerEvent): boolean {
		const now = performance.now();
		const hit = !!lastTap && lastTap.key === key && now - lastTap.t < 400 && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 6;
		lastTap = hit ? null : { key, t: now, x: event.clientX, y: event.clientY };
		// A double-click selects nearby text (e.g. in the sidebar); clear it.
		if (hit) window.getSelection()?.removeAllRanges();
		return hit;
	}

	function endPointer(event: PointerEvent) {
		const a = action;
		action = null;
		panning = false;
		if (!a) return;
		const tap = event.type === 'pointerup' && !a.moved;
		if (a.kind === 'pan') {
			if (tap && event.button !== 1) {
				if (isDoubleTap('canvas', event)) glideTo(zoomAt(current(), 1.5, local(event)), 180);
				else onselect(null);
			}
			return;
		}
		if (a.kind === 'zone' || a.kind === 'resize') {
			if (a.moved) onzonechanged(a.id, true);
			else if (a.kind === 'zone' && tap && isDoubleTap(`zone:${a.id}`, event)) onzonerenamestart(a.id);
			return;
		}
		dragId = null;
		const target = dropZone;
		dropZone = null;
		if (!a.moved) {
			if (tap && isDoubleTap(`card:${a.id}`, event)) onrenamesessionstart(a.id);
			else select(a.id);
			return;
		}
		const p = positions.get(a.id);
		if (!p) return;
		onmoved(a.id, p, target, zoneOf.get(a.id) ?? null);
	}

	function select(id: string) {
		onselect(id);
		// If the card would sit under the sidebar, glide it into view.
		const p = positions.get(id);
		if (!p) return;
		const c = current();
		const right = c.x + (p.x + CARD_WIDTH) * c.z;
		const bottom = c.y + (p.y + cardHeight(id)) * c.z;
		const left = c.x + p.x * c.z;
		const top = c.y + p.y * c.z;
		const v = visibleArea(true);
		if (right > v.x + v.w - 16 || left < v.x || top < v.y || bottom > v.y + v.h) focusOn(id);
	}

	// Wheel and Safari gesture listeners must be non-passive to stop page zoom.
	$effect(() => {
		const onwheel = (event: WheelEvent) => {
			if ((event.target as HTMLElement).closest('.chrome')) return;
			event.preventDefault();
			cancelAnimationFrame(glide);
			const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? vh : 1;
			if (event.ctrlKey || event.metaKey || scrollZooms) {
				const factor = Math.exp(-event.deltaY * unit * (event.ctrlKey ? 0.012 : 0.0025));
				setCam(zoomAt(current(), factor, local(event)));
			} else {
				const c = current();
				setCam({ ...c, x: c.x - event.deltaX * unit, y: c.y - event.deltaY * unit });
			}
		};
		let lastScale = 1;
		const ongesturestart = (event: Event) => {
			event.preventDefault();
			lastScale = 1;
		};
		const ongesturechange = (event: Event) => {
			event.preventDefault();
			const e = event as Event & { scale: number; clientX: number; clientY: number };
			setCam(zoomAt(current(), e.scale / lastScale, local(e)));
			lastScale = e.scale;
		};
		vp.addEventListener('wheel', onwheel, { passive: false });
		vp.addEventListener('gesturestart', ongesturestart);
		vp.addEventListener('gesturechange', ongesturechange);
		return () => {
			vp.removeEventListener('wheel', onwheel);
			vp.removeEventListener('gesturestart', ongesturestart);
			vp.removeEventListener('gesturechange', ongesturechange);
		};
	});

	// ---------- keyboard ----------
	const ARROWS: Record<string, Direction> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

	function isTyping(target: EventTarget | null): boolean {
		const el = target as HTMLElement | null;
		return !!el?.closest?.('input, textarea, select, [contenteditable="true"]');
	}
	function inPanel(target: EventTarget | null): boolean {
		return !!(target as HTMLElement | null)?.closest?.('.side, .hc-pop, .menu');
	}
	function focusCard(id: string) {
		vp.querySelector<HTMLElement>(`.hc-card[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
	}

	function onkeydown(event: KeyboardEvent) {
		if (isTyping(event.target)) return;
		if (event.key === 'Escape') {
			onescape();
			return;
		}
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (event.key === '/') {
			event.preventDefault();
			onfocusfilter();
			return;
		}
		if (inPanel(event.target)) return;
		const onCard = (event.target as HTMLElement).closest?.('.hc-card') as HTMLElement | null;
		if (event.key === 'Enter' && onCard?.dataset.id) {
			select(onCard.dataset.id);
			return;
		}
		if (event.key === ' ') {
			// Space pans; let it activate real buttons.
			if ((event.target as HTMLElement).closest?.('button')) return;
			spaceHeld = true;
			event.preventDefault();
			return;
		}
		const direction = ARROWS[event.key];
		if (direction) {
			event.preventDefault();
			const from = boxes.find((b) => b.id === selectedId);
			const next = from ? nearestInDirection(from, boxes, direction) : [...boxes].sort((a, b) => a.y - b.y || a.x - b.x)[0];
			if (next) {
				onselect(next.id);
				focusOn(next.id);
				focusCard(next.id);
			}
			return;
		}
		switch (event.key) {
			case '+':
			case '=':
				zoomBy(1.25);
				break;
			case '-':
			case '_':
				zoomBy(0.8);
				break;
			case '0':
				resetZoom();
				break;
			case '1':
				fitAll();
				break;
			case 'f':
			case 'F':
				if (selectedId) focusOn(selectedId);
				break;
			case 'n':
			case 'N':
				onnewzone(viewCentre());
				break;
			default:
				return;
		}
		event.preventDefault();
	}
	function onkeyup(event: KeyboardEvent) {
		if (event.key === ' ') spaceHeld = false;
	}

	function jump(world: Point) {
		glideTo(centreOn(world, visibleArea(), current().z), 180);
	}
</script>

<svelte:window {onkeydown} {onkeyup} onblur={() => (spaceHeld = false)} />

<main
	class="viewport"
	class:is-panning={panning}
	class:is-space={spaceHeld}
	class:lod={compact}
	bind:this={vp}
	bind:clientWidth={vw}
	bind:clientHeight={vh}
	aria-label="Session canvas. Arrow keys move between cards, plus and minus zoom, 1 fits all, N adds a zone, slash filters."
	{onpointerdown}
	{onpointermove}
	onpointerup={endPointer}
	onpointercancel={endPointer}
>
	<canvas class="grid" bind:this={gridEl} style:width="{vw}px" style:height="{vh}px" aria-hidden="true"></canvas>
	<div class="world" style:transform="translate3d({cam.x}px, {cam.y}px, 0) scale({cam.z})" style:--lod={lod}>
		{#each zoneList as zone (zone.id)}
			<Zone
				{zone}
				count={memberCount.get(zone.id) ?? 0}
				drop={dropZone === zone.id}
				renaming={renamingZone === zone.id}
				onrename={(name) => onzonerename(zone.id, name)}
			/>
		{/each}
		{#each placed as item (item.session.id)}
			<SessionCard
				session={item.session}
				title={titlesOf.get(item.session.id) ?? null}
				renaming={renamingSession === item.session.id}
				onrename={(title) => onrenamesession(item.session.id, title)}
				x={item.x}
				y={item.y}
				{now}
				{compact}
				tags={item.tags}
				activeTags={filter?.tags ?? []}
				highlighted={!!filter && item.match && filter.mode === 'highlight'}
				dimmed={!!filter && !item.match && filter.mode === 'highlight'}
				hidden={!!filter && !item.match && filter.mode === 'only' && item.session.id !== selectedId}
				selected={item.session.id === selectedId}
				dragging={item.session.id === dragId}
			/>
		{/each}
	</div>

	<div class="chrome tools hc-float hc-toolbar">
		<button class="hc-iconbtn" onclick={() => onnewzone(viewCentre())} aria-label="New zone" title="New zone (N)"><Icon name="zone" /></button>
	</div>

	<div class="chrome zoom hc-float hc-zoom">
		<button class="hc-iconbtn" onclick={() => zoomBy(0.8)} aria-label="Zoom out" title="Zoom out (−)"><Icon name="minus" /></button>
		<button class="hc-zoom__val" onclick={resetZoom} title="Reset to 100% (0)">{zoomLabel}</button>
		<button class="hc-iconbtn" onclick={() => zoomBy(1.25)} aria-label="Zoom in" title="Zoom in (+)"><Icon name="plus" /></button>
		<span class="hc-sep zoom-sep"></span>
		<button class="hc-iconbtn" onclick={() => fitAll()} aria-label="Fit all" title="Fit all (1)"><Icon name="fit" /></button>
	</div>

	{#if vw > 760 && (boxes.length || zoneList.length)}
		<div class="chrome mini" class:shifted={sideOpen}>
			<Minimap cards={boxes} zones={zoneList} {selectedId} dimmed={filter?.mode === 'highlight' ? filter.matches : null} camera={cam} viewport={{ w: vw, h: vh }} onjump={jump} />
		</div>
	{/if}
</main>

<style>
	.viewport {
		position: absolute;
		inset: 0;
		overflow: hidden;
		outline: none;
		touch-action: none;
		user-select: none;
		cursor: default;
	}
	.viewport.is-space,
	.viewport.is-panning {
		cursor: grab;
	}
	.viewport.is-panning:active {
		cursor: grabbing;
	}
	.grid {
		position: absolute;
		left: 0;
		top: 0;
		pointer-events: none;
	}
	.world {
		position: absolute;
		left: 0;
		top: 0;
		transform-origin: 0 0;
		will-change: transform;
	}
	.chrome {
		position: absolute;
		z-index: var(--z-chrome);
	}
	.tools {
		left: var(--space-3);
		top: calc(var(--topbar-height) + var(--space-3));
	}
	.zoom {
		left: var(--space-3);
		bottom: var(--space-3);
	}
	.zoom-sep {
		height: 16px;
		margin: 0 2px;
	}
	.mini {
		right: var(--space-3);
		bottom: var(--space-3);
		transition: right var(--dur-panel) var(--ease-out);
	}
	.mini.shifted {
		right: calc(var(--sidebar-width) + 20px);
	}
</style>
