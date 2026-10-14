<script lang="ts">
	import {
		ZONE_COLORS,
		type ProviderStatus,
		type Session,
		type TagsResponse,
		type Zone,
		type ZoneColor,
		type ZoneInput
	} from '@halcyon/core';
	import { onMount } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { invalidateAll } from '$app/navigation';
	import { api } from '#lib/api.js';
	import { bounds, CARD_HEIGHT, CARD_WIDTH, type Camera, type Point } from '#lib/canvas/geometry.js';
	import {
		arrangeZone,
		cardHeightFor,
		columnsFor,
		freeSpot,
		packWidth,
		projectZoneNames,
		pushDown,
		readingOrder,
		shelfPack,
		zoneWidthFor
	} from '#lib/canvas/arrange.js';
	import { placeNew } from '#lib/canvas/layout.js';
	import Canvas from '#lib/components/Canvas.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import Sidebar from '#lib/components/Sidebar.svelte';
	import TagFilter from '#lib/components/TagFilter.svelte';
	import { displayTitle, plural, providerMonogram } from '#lib/format.js';
	import { readPref, writePref } from '#lib/prefs.js';
	import { currentTheme, setTheme, type Theme } from '#lib/theme.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// ---------- freshness ----------
	// The server answers from its snapshot and rescans in the background, so polling is cheap.
	const POLL_MS = 15_000;
	let now = $state(Date.now());
	$effect(() => {
		const tick = () => {
			if (document.visibilityState !== 'visible') return;
			now = Date.now();
			void invalidateAll();
		};
		const timer = setInterval(tick, POLL_MS);
		document.addEventListener('visibilitychange', tick);
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', tick);
		};
	});

	let rescanning = $state(false);
	async function rescan() {
		rescanning = true;
		try {
			await invalidateAll();
			if (workspaceError) await loadWorkspace();
			now = Date.now();
		} finally {
			rescanning = false;
		}
	}

	// ---------- preferences ----------
	let theme = $state<Theme>(currentTheme());
	function toggleTheme() {
		theme = theme === 'dark' ? 'light' : 'dark';
		setTheme(theme);
	}
	let scrollZooms = $state(readPref('scrollZooms', false));
	let gridOn = $state(readPref('grid', true));
	let menuOpen = $state(false);
	let bannerDismissed = $state(readPref('foundBannerDismissed', false));
	function dismissBanner() {
		bannerDismissed = true;
		writePref('foundBannerDismissed', true);
	}

	// ---------- toast ----------
	let toast = $state<{ message: string; undo?: () => Promise<void> } | null>(null);
	let toastTimer: ReturnType<typeof setTimeout> | undefined;
	/** Toasts confirm; anything that moved more than one thing offers Undo. */
	function showToast(message: string, undo?: () => Promise<void>) {
		toast = undo ? { message, undo } : { message };
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = null), undo ? 6000 : 2400);
	}
	async function runUndo() {
		const undo = toast?.undo;
		toast = null;
		if (!undo) return;
		try {
			await undo();
		} catch {
			showToast("Couldn't undo. Reload to see the saved layout.");
		}
	}
	const saveFailed = () => showToast("Couldn't save that change. It stays until you reload.");

	// ---------- data ----------
	const providers = $derived(data.sessions?.providers ?? []);
	const sessions = $derived(data.sessions?.sessions ?? []);
	const problems = $derived(providers.filter((p) => p.health.state !== 'ok'));
	const agentsFound = $derived(providers.filter((p) => p.health.state === 'ok').length);

	// Workspace layout: loaded once, then owned here. Polling only refreshes sessions.
	const positions = new SvelteMap<string, Point>();
	const zoneOf = new SvelteMap<string, number | null>();
	const zones = new SvelteMap<number, Zone>();
	const tagsOf = new SvelteMap<string, string[]>();
	const titlesOf = new SvelteMap<string, string>();
	let initialCamera = $state<Camera | null>(null);
	let workspaceReady = $state(false);
	let workspaceError = $state(false);

	function applyTags(state: TagsResponse) {
		const names = new Map(state.tags.map((t) => [t.id, t.name]));
		const next = new Map<string, string[]>();
		for (const { sessionId, tagId } of state.sessionTags) {
			const name = names.get(tagId);
			if (name) next.set(sessionId, [...(next.get(sessionId) ?? []), name]);
		}
		for (const id of [...tagsOf.keys()]) if (!next.has(id)) tagsOf.delete(id);
		for (const [id, list] of next) tagsOf.set(id, list.sort());
	}

	async function loadWorkspace() {
		try {
			const workspace = await api.workspace();
			for (const p of workspace.placements) {
				positions.set(p.sessionId, { x: p.x, y: p.y });
				zoneOf.set(p.sessionId, p.zoneId);
			}
			for (const z of workspace.zones) zones.set(z.id, z);
			for (const t of workspace.titles) titlesOf.set(t.sessionId, t.title);
			applyTags(workspace);
			if (workspace.filter) {
				filterTags = workspace.filter.tags;
				filterMode = workspace.filter.mode;
			}
			initialCamera = workspace.viewport ? { x: workspace.viewport.x, y: workspace.viewport.y, z: workspace.viewport.zoom } : null;
			workspaceError = false;
			workspaceReady = true;
		} catch {
			workspaceError = true;
		}
	}
	onMount(() => {
		void loadWorkspace();
	});

	// ---------- layout engine ----------
	// Zones are containers: their cards sit in a grid with no overlaps, the width
	// sets the columns and the height always fits. When a zone grows, whatever
	// it now overlaps is pushed down. Every change is collected and saved once.
	interface Changes {
		cards: Set<string>;
		zones: Set<number>;
	}
	const newChanges = (): Changes => ({ cards: new Set(), zones: new Set() });
	const presentIds = $derived(new Set<string>(sessions.map((s) => s.id)));
	const cardH = (id: string) => cardHeightFor((tagsOf.get(id)?.length ?? 0) > 0);
	const zoneBox = (z: Zone) => ({ x: z.x, y: z.y, w: z.width, h: z.height });
	const projectKey = (s: Session) => s.projectRoot ?? s.projectPath ?? null;
	const membersOf = (zoneId: number) => [...zoneOf].filter(([id, z]) => z === zoneId && presentIds.has(id)).map(([id]) => id);
	const zoneName = (id: number | null) => (id === null ? null : (zones.get(id)?.name ?? null));
	const zoneInput = (z: Zone): ZoneInput => ({
		name: z.name,
		color: z.color,
		x: z.x,
		y: z.y,
		width: z.width,
		height: z.height,
		projectPath: z.projectPath
	});

	/** Re-lays out a zone's cards, optionally inserting one at a drop point, and fits the zone. */
	function reflowZone(zoneId: number, changed: Changes, options: { insert?: { id: string; at: Point }; separate?: boolean } = {}) {
		const zone = zones.get(zoneId);
		if (!zone) return;
		const cards = membersOf(zoneId).flatMap((id) => {
			const p = options.insert?.id === id ? options.insert.at : positions.get(id);
			return p ? [{ id, x: p.x, y: p.y }] : [];
		});
		const order = readingOrder(zoneBox(zone), cards);
		const result = arrangeZone(zoneBox(zone), order.map((id) => ({ id, h: cardH(id) })));
		for (const [id, p] of result.positions) {
			const old = positions.get(id);
			if (!old || old.x !== p.x || old.y !== p.y) {
				positions.set(id, p);
				changed.cards.add(id);
			}
		}
		if (result.w !== zone.width || result.h !== zone.height) {
			const grew = result.h > zone.height || result.w > zone.width;
			zones.set(zoneId, { ...zone, width: result.w, height: result.h });
			changed.zones.add(zoneId);
			if (grew && options.separate !== false) separate(zoneId, changed);
		}
	}

	/** Pushes zones and free cards that overlap this zone down below it. */
	function separate(zoneId: number, changed: Changes) {
		const zone = zones.get(zoneId);
		if (!zone) return;
		const obstacles = [
			...[...zones.values()].filter((z) => z.id !== zoneId).map((z) => ({ id: `z:${z.id}`, ...zoneBox(z) })),
			...sessions.flatMap((s) => {
				const p = positions.get(s.id);
				return p && (zoneOf.get(s.id) ?? null) === null ? [{ id: `c:${s.id}`, x: p.x, y: p.y, w: CARD_WIDTH, h: cardH(s.id) }] : [];
			})
		];
		for (const [key, dy] of pushDown({ id: `z:${zoneId}`, ...zoneBox(zone) }, obstacles)) {
			if (key.startsWith('z:')) {
				const id = Number(key.slice(2));
				const z = zones.get(id);
				if (!z) continue;
				zones.set(id, { ...z, y: z.y + dy });
				changed.zones.add(id);
				for (const m of membersOf(id)) {
					const p = positions.get(m);
					if (p) {
						positions.set(m, { x: p.x, y: p.y + dy });
						changed.cards.add(m);
					}
				}
			} else {
				const id = key.slice(2);
				const p = positions.get(id);
				if (p) {
					positions.set(id, { x: p.x, y: p.y + dy });
					changed.cards.add(id);
				}
			}
		}
	}

	function persist(changed: Changes) {
		for (const id of changed.zones) {
			const zone = zones.get(id);
			if (zone) api.updateZone(id, { x: zone.x, y: zone.y, width: zone.width, height: zone.height }).catch(saveFailed);
		}
		const batch = [...changed.cards].flatMap((id) => {
			const p = positions.get(id);
			return p ? [{ sessionId: id as Session['id'], x: p.x, y: p.y, zoneId: zoneOf.get(id) ?? null }] : [];
		});
		if (batch.length) api.savePlacements(batch).catch(saveFailed);
	}

	/** Boxes of everything except the given card, for finding free space. */
	function obstaclesExcept(id: string) {
		return [
			...[...zones.values()].map(zoneBox),
			...sessions.flatMap((s) => {
				const p = positions.get(s.id);
				return p && s.id !== id ? [{ x: p.x, y: p.y, w: CARD_WIDTH, h: cardH(s.id) }] : [];
			})
		];
	}

	// Sessions without a saved position: join their project's zone when there is
	// one, otherwise are placed by project below the existing layout. Saved once,
	// so later discoveries never move existing cards.
	$effect(() => {
		if (!workspaceReady) return;
		const unplaced = sessions
			.filter((s) => !positions.has(s.id))
			.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
		if (unplaced.length === 0) return;
		const changed = newChanges();
		const projectZones = new Map([...zones.values()].filter((z) => z.projectPath).map((z) => [z.projectPath!, z]));
		const loose: Session[] = [];
		const joined = new Set<number>();
		unplaced.forEach((s, i) => {
			const zone = projectZones.get(projectKey(s) ?? '');
			if (!zone) return loose.push(s);
			positions.set(s.id, { x: zone.x + zone.width, y: zone.y + zone.height + 10_000 + i });
			zoneOf.set(s.id, zone.id);
			changed.cards.add(s.id);
			joined.add(zone.id);
		});
		for (const id of joined) reflowZone(id, changed);
		if (loose.length) {
			const existing = [
				...[...positions.values()].map((p) => ({ ...p, w: CARD_WIDTH, h: CARD_HEIGHT })),
				...[...zones.values()].map(zoneBox)
			].filter((b) => b.y < 5_000_000);
			const placed = placeNew(
				loose.map((s) => ({ id: s.id, group: projectKey(s) ?? '' })),
				existing
			);
			for (const s of loose) {
				const p = placed.get(s.id);
				if (!p) continue;
				positions.set(s.id, p);
				changed.cards.add(s.id);
			}
		}
		persist(changed);
	});

	// ---------- filter ----------
	let filterTags = $state<string[]>([]);
	let filterMode = $state<'highlight' | 'only'>('highlight');
	let filterText = $state('');
	let tagFilter = $state<TagFilter>();
	const tagCounts = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const [id, list] of tagsOf) if (presentIds.has(id)) for (const t of list) counts.set(t, (counts.get(t) ?? 0) + 1);
		return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	});
	const nameOf = (s: Session) => titlesOf.get(s.id) ?? displayTitle(s);
	const filterView = $derived.by(() => {
		const text = filterText.trim().replace(/^#/, '').toLowerCase();
		if (filterTags.length === 0 && !text) return null;
		const matches = new Set<string>();
		for (const s of sessions) {
			const tags = tagsOf.get(s.id) ?? [];
			if (filterTags.length && !tags.some((t) => filterTags.includes(t))) continue;
			if (text) {
				const haystack = [nameOf(s), s.title ?? '', s.projectPath ?? '', s.latestPath ?? '', ...tags].join(' ').toLowerCase();
				if (!haystack.includes(text)) continue;
			}
			matches.add(s.id);
		}
		return { tags: filterTags, mode: filterMode, matches };
	});
	// Tag filters are saved with the workspace; search text is not.
	$effect(() => {
		const saved = filterTags.length ? { tags: [...filterTags], mode: filterMode } : null;
		if (!workspaceReady) return;
		const timer = setTimeout(() => api.saveFilter(saved).catch(() => {}), 400);
		return () => clearTimeout(timer);
	});

	// ---------- layout changes from the canvas ----------
	function moved(id: string, drop: Point, zoneId: number | null, previous: number | null) {
		const changed = newChanges();
		changed.cards.add(id);
		zoneOf.set(id, zoneId);
		if (zoneId !== null) {
			reflowZone(zoneId, changed, { insert: { id, at: drop } });
		} else {
			// Open canvas: nudge into the nearest free space so cards never overlap.
			positions.set(id, freeSpot({ ...drop, w: CARD_WIDTH, h: cardH(id) }, obstaclesExcept(id)));
		}
		if (previous !== null && previous !== zoneId) reflowZone(previous, changed);
		persist(changed);
		if (zoneId !== previous) showToast(zoneId !== null ? `Moved to ${zoneName(zoneId)}` : 'Removed from zone');
	}

	/** End of a zone move or resize: save it and its cards, and clear any overlaps. */
	function zoneChanged(zoneId: number) {
		const changed = newChanges();
		changed.zones.add(zoneId);
		for (const id of membersOf(zoneId)) changed.cards.add(id);
		reflowZone(zoneId, changed, { separate: false });
		separate(zoneId, changed);
		persist(changed);
	}

	/** Live re-layout while a zone is resized (saved when the resize ends). */
	function zoneReflow(zoneId: number) {
		reflowZone(zoneId, newChanges(), { separate: false });
	}

	let renamingZone = $state<number | null>(null);
	function zoneRename(zoneId: number, name: string | null) {
		renamingZone = null;
		const zone = zones.get(zoneId);
		const next = name?.trim().slice(0, 80);
		if (!zone || !next || next === zone.name) return;
		zones.set(zoneId, { ...zone, name: next });
		api.updateZone(zoneId, { name: next }).catch(saveFailed);
	}

	async function newZone(centre: Point) {
		const input: ZoneInput = {
			name: 'New zone',
			color: ZONE_COLORS[zones.size % ZONE_COLORS.length]!,
			x: Math.round(centre.x - 160),
			y: Math.round(centre.y - 100),
			width: zoneWidthFor(2),
			height: 200
		};
		const spot = freeSpot({ x: input.x, y: input.y, w: input.width, h: input.height }, obstaclesExcept(''));
		try {
			const zone = await api.createZone({ ...input, x: Math.round(spot.x), y: Math.round(spot.y) });
			zones.set(zone.id, zone);
			renamingZone = zone.id;
		} catch {
			saveFailed();
		}
	}

	function deleteZone(zoneId: number) {
		const zone = zones.get(zoneId);
		if (!zone) return;
		const members = [...zoneOf].filter(([, z]) => z === zoneId).map(([id]) => id);
		zones.delete(zoneId);
		for (const id of members) zoneOf.set(id, null);
		api.deleteZone(zoneId).catch(saveFailed);
		showToast(`Deleted ${zone.name}`, async () => {
			const restored = await api.createZone(zoneInput(zone));
			zones.set(restored.id, restored);
			const batch = members.flatMap((id) => {
				const p = positions.get(id);
				if (!p) return [];
				zoneOf.set(id, restored.id);
				return [{ sessionId: id as Session['id'], x: p.x, y: p.y, zoneId: restored.id }];
			});
			if (batch.length) await api.savePlacements(batch);
		});
	}

	/** Sidebar zone picker: append to a zone, or step out beside it. */
	function moveToZone(id: string, zoneId: number | null) {
		const previous = zoneOf.get(id) ?? null;
		const p = positions.get(id);
		if (!p || zoneId === previous) return;
		const changed = newChanges();
		changed.cards.add(id);
		zoneOf.set(id, zoneId);
		if (zoneId !== null) {
			const zone = zones.get(zoneId);
			if (!zone) return;
			reflowZone(zoneId, changed, { insert: { id, at: { x: zone.x + zone.width, y: zone.y + zone.height + 10_000 } } });
		} else {
			const from = previous !== null ? zones.get(previous) : undefined;
			const near = from ? { x: from.x + from.width + 24, y: p.y } : p;
			positions.set(id, freeSpot({ ...near, w: CARD_WIDTH, h: cardH(id) }, obstaclesExcept(id)));
		}
		if (previous !== null) reflowZone(previous, changed);
		persist(changed);
		canvas?.focusOn(id);
		showToast(zoneId !== null ? `Moved to ${zoneName(zoneId)}` : 'Removed from zone');
	}

	/** Snapshot for Undo of multi-card changes. */
	function snapshot(ids: string[], zoneIds: number[]) {
		return {
			cards: ids.map((id) => ({ id, p: { ...positions.get(id)! }, zone: zoneOf.get(id) ?? null })),
			zones: zoneIds.flatMap((id) => (zones.has(id) ? [{ ...zones.get(id)! }] : []))
		};
	}
	async function restore(snap: ReturnType<typeof snapshot>, createdZones: number[]) {
		for (const id of createdZones) zones.delete(id);
		for (const z of snap.zones) zones.set(z.id, z);
		for (const c of snap.cards) {
			positions.set(c.id, c.p);
			zoneOf.set(c.id, c.zone);
		}
		await api.savePlacements(snap.cards.map((c) => ({ sessionId: c.id as Session['id'], ...c.p, zoneId: c.zone })));
		for (const z of snap.zones) await api.updateZone(z.id, { x: z.x, y: z.y, width: z.width, height: z.height });
		for (const id of createdZones) await api.deleteZone(id);
		canvas?.fitAll();
	}

	/** Creates zones (sized to fit) for groups of cards, packed below the existing layout. */
	async function createZonesFor(plan: { name: string; projectPath: string | null; ids: string[]; color: ZoneColor }[], changed: Changes) {
		const sizes = plan.map((p) => {
			const width = zoneWidthFor(columnsFor(p.ids.length));
			return { w: width, h: arrangeZone({ x: 0, y: 0, w: width, h: 0 }, p.ids.map((id) => ({ id, h: cardH(id) }))).h };
		});
		const moving = new Set(plan.flatMap((p) => p.ids));
		const staying = [
			...[...zones.values()].map(zoneBox),
			...sessions.flatMap((s) => {
				const p = positions.get(s.id);
				return p && !moving.has(s.id) ? [{ x: p.x, y: p.y, w: CARD_WIDTH, h: cardH(s.id) }] : [];
			})
		];
		const movingBoxes = [...moving].flatMap((id) => {
			const p = positions.get(id);
			return p ? [{ x: p.x, y: p.y, w: CARD_WIDTH, h: cardH(id) }] : [];
		});
		const area = bounds(staying);
		const origin = area ? { x: Math.round(area.x), y: Math.round(area.y + area.h + 96) } : (bounds(movingBoxes) ?? { x: 0, y: 0 });
		const points = shelfPack(sizes, origin, packWidth(sizes));
		const created: number[] = [];
		for (const [i, p] of plan.entries()) {
			const zone = await api.createZone({
				name: p.name,
				color: p.color,
				x: Math.round(points[i]!.x),
				y: Math.round(points[i]!.y),
				width: sizes[i]!.w,
				height: sizes[i]!.h,
				projectPath: p.projectPath
			});
			zones.set(zone.id, zone);
			created.push(zone.id);
			p.ids.forEach((id, k) => {
				zoneOf.set(id, zone.id);
				positions.set(id, { x: zone.x + k, y: zone.y + 10_000 + k });
			});
			reflowZone(zone.id, changed, { separate: false });
			for (const id of p.ids) changed.cards.add(id);
		}
		return created;
	}

	async function zoneFromFilter() {
		const view = filterView;
		if (!view || !canvas || view.tags.length === 0) return;
		const hits = sessions.filter((s) => view.matches.has(s.id) && positions.has(s.id)).map((s) => s.id);
		if (hits.length === 0) return showToast('No sessions match this filter');
		const previousZones = [...new Set(hits.map((id) => zoneOf.get(id)).filter((z): z is number => z != null))];
		const snap = snapshot(hits, previousZones);
		const name = view.tags.map((t) => `#${t}`).join(' + ').slice(0, 80);
		const changed = newChanges();
		try {
			const created = await createZonesFor([{ name, projectPath: null, ids: hits, color: 'iris' }], changed);
			for (const z of previousZones) reflowZone(z, changed);
			persist(changed);
			const zone = zones.get(created[0]!);
			if (zone) canvas.fitBox(zoneBox(zone));
			showToast(`Moved ${plural(hits.length, 'session')} into ${name}`, () => restore(snap, created));
		} catch {
			saveFailed();
		}
	}

	/**
	 * One zone per project (git repository root when found) for every session
	 * not already in a zone. Projects with a single session share an "Other
	 * folders" zone. Sessions whose project already has a zone join it. New
	 * sessions keep flowing into their project's zone afterwards.
	 */
	async function groupByProject() {
		menuOpen = false;
		if (!canvas) return;
		const free = sessions
			.filter((s) => positions.has(s.id) && (zoneOf.get(s.id) ?? null) === null)
			.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
		if (free.length === 0) return showToast('Every session is already in a zone');
		const projectZones = new Map([...zones.values()].filter((z) => z.projectPath).map((z) => [z.projectPath!, z.id]));
		const groups = new Map<string, string[]>();
		const others: string[] = [];
		const joining = new Map<number, string[]>();
		for (const s of free) {
			const key = projectKey(s);
			const existing = key ? projectZones.get(key) : undefined;
			if (existing !== undefined) joining.set(existing, [...(joining.get(existing) ?? []), s.id]);
			else if (key) groups.set(key, [...(groups.get(key) ?? []), s.id]);
			else others.push(s.id);
		}
		for (const [key, ids] of [...groups]) {
			if (ids.length < 2) {
				others.push(...ids);
				groups.delete(key);
			}
		}
		const names = projectZoneNames([...groups.keys()]);
		const plan: { name: string; projectPath: string | null; ids: string[]; color: ZoneColor }[] = [...groups].map(([key, ids], i) => ({
			name: names.get(key) ?? key,
			projectPath: key,
			ids,
			color: ZONE_COLORS[(zones.size + i) % ZONE_COLORS.length]!
		}));
		if (others.length) plan.push({ name: 'Other folders', projectPath: null, ids: others, color: 'slate' });

		const snap = snapshot(
			free.map((s) => s.id),
			[...joining.keys()]
		);
		const changed = newChanges();
		try {
			const created = await createZonesFor(plan, changed);
			for (const [zoneId, ids] of joining) {
				const zone = zones.get(zoneId)!;
				ids.forEach((id, k) => {
					zoneOf.set(id, zoneId);
					positions.set(id, { x: zone.x + zone.width + k, y: zone.y + zone.height + 10_000 + k });
					changed.cards.add(id);
				});
				reflowZone(zoneId, changed);
			}
			persist(changed);
			canvas.fitAll();
			dismissBanner();
			showToast(`Grouped ${plural(free.length, 'session')} into ${plural(created.length + joining.size, 'zone')}`, () =>
				restore(snap, created)
			);
		} catch {
			saveFailed();
		}
	}

	async function setTags(id: string, tags: string[]) {
		const previous = tagsOf.get(id) ?? [];
		tagsOf.set(id, [...tags].sort());
		try {
			applyTags(await api.setTags(id, tags));
			// Tags change a card's height; keep its zone tidy.
			const zoneId = zoneOf.get(id) ?? null;
			if (zoneId !== null && (previous.length === 0) !== (tags.length === 0)) {
				const changed = newChanges();
				reflowZone(zoneId, changed);
				persist(changed);
			}
		} catch (error) {
			tagsOf.set(id, previous);
			showToast(error instanceof Error ? error.message : "Couldn't save tags");
		}
	}

	// ---------- session names ----------
	let renamingSession = $state<string | null>(null);
	/** Saves a Halcyon display name; empty or the original name resets it. */
	function renameSession(id: string, title: string | null) {
		renamingSession = null;
		if (title === null) return;
		const session = sessions.find((s) => s.id === id);
		const next = title.trim().slice(0, 120);
		const original = session ? displayTitle(session) : '';
		const previous = titlesOf.get(id) ?? null;
		const value = next === '' || next === original ? null : next;
		if (value === previous) return;
		if (value === null) titlesOf.delete(id);
		else titlesOf.set(id, value);
		api.setTitle(id, value).catch(() => {
			if (previous === null) titlesOf.delete(id);
			else titlesOf.set(id, previous);
			saveFailed();
		});
	}

	function cameraChanged(c: Camera) {
		api.saveViewport({ x: Math.round(c.x), y: Math.round(c.y), zoom: c.z }).catch(() => {
			// The view is a convenience; a failed save is not worth interrupting for.
		});
	}

	function escape() {
		if (renamingZone !== null || renamingSession !== null) return;
		if (menuOpen) menuOpen = false;
		else if (selectedId) selectedId = null;
		else if (filterTags.length || filterText) {
			filterTags = [];
			filterText = '';
		}
	}

	// ---------- selection ----------
	let selectedId = $state<string | null>(null);
	const selected = $derived(selectedId ? (sessions.find((s) => s.id === selectedId) ?? null) : null);
	$effect(() => {
		// A session that disappears closes its sidebar.
		if (selectedId && data.sessions && !selected) selectedId = null;
	});
	let canvas = $state<Canvas>();

	// ---------- text ----------
	function healthSummary(status: ProviderStatus): string {
		const { health } = status;
		if (health.state === 'ok') return `${status.displayName} · ${plural(health.sessionCount, 'session')}`;
		if (health.state === 'unavailable') return `${status.displayName} not found · ${health.reason}`;
		return `${status.displayName} scan failed · ${health.message}`;
	}
	function problemText(status: ProviderStatus): string {
		const { health } = status;
		if (health.state === 'unavailable') return `${status.displayName} not found. ${health.reason}`;
		if (health.state === 'error') return `Couldn't scan ${status.displayName}. Showing the last sessions found.`;
		return '';
	}

	function closeMenuOutside(event: PointerEvent) {
		if (menuOpen && !(event.target as HTMLElement).closest('.menu, .menu-btn')) menuOpen = false;
	}
</script>

<svelte:window onpointerdown={closeMenuOutside} />

<div class="hc-root app" class:has-side={!!selected}>
	{#if data.error || workspaceError}
		<div class="center">
			<div class="hc-empty">
				<svg class="hc-empty__art" viewBox="0 0 120 72" aria-hidden="true">
					<rect x="30" y="18" width="60" height="36" rx="6" class="art-card" />
					<path d="M52 36h16" class="art-line" />
				</svg>
				<h2>Halcyon's server isn't responding</h2>
				<p>Start it with <code class="hc-mono">halcyon</code>, then retry.</p>
				<div class="actions"><button class="hc-btn hc-btn--primary" onclick={rescan} disabled={rescanning}>Retry</button></div>
			</div>
		</div>
	{:else if data.sessions && sessions.length === 0}
		<div class="center dotted">
			<div class="hc-empty">
				<svg class="hc-empty__art" viewBox="0 0 120 72" aria-hidden="true">
					<rect x="8" y="14" width="60" height="34" rx="6" class="art-card" />
					<rect x="52" y="28" width="60" height="34" rx="6" class="art-card art-dashed" />
					<circle cx="18" cy="24" r="3" class="art-dot" />
				</svg>
				{#if agentsFound === 0}
					<h2>No agents detected</h2>
					<p>Halcyon reads local Claude Code and Codex sessions. Install either one, run a session, then rescan.</p>
					<div class="commands">
						<div class="hc-cmd"><code>npm i -g @anthropic-ai/claude-code</code></div>
						<div class="hc-cmd"><code>npm i -g @openai/codex</code></div>
					</div>
				{:else}
					<h2>No sessions yet</h2>
					<p>
						Halcyon found {providers.filter((p) => p.health.state === 'ok').map((p) => p.displayName).join(' and ')}, but no
						sessions. Start one in any project and it appears here.
					</p>
				{/if}
				<div class="actions"><button class="hc-btn hc-btn--primary" onclick={rescan} disabled={rescanning}>Rescan</button></div>
			</div>
		</div>
	{:else if workspaceReady}
		<Canvas
			bind:this={canvas}
			{sessions}
			{positions}
			{zones}
			{zoneOf}
			{tagsOf}
			{titlesOf}
			{renamingSession}
			filter={filterView}
			{selectedId}
			{renamingZone}
			sideOpen={!!selected}
			{now}
			{initialCamera}
			{scrollZooms}
			{gridOn}
			onselect={(id) => (selectedId = id)}
			onmoved={moved}
			onzonereflow={zoneReflow}
			onrenamesessionstart={(id) => {
				selectedId = id;
				renamingSession = id;
			}}
			onrenamesession={renameSession}
			onzonechanged={zoneChanged}
			onzonerename={zoneRename}
			onzonerenamestart={(id) => (renamingZone = id)}
			onzonedelete={deleteZone}
			onnewzone={newZone}
			onescape={escape}
			onfocusfilter={() => tagFilter?.focus()}
			oncamera={cameraChanged}
		/>

		{#if problems.length || !bannerDismissed}
			<div class="banners" aria-live="polite">
				{#each problems as status (status.provider)}
					<div class="hc-float hc-banner">
						{#if status.health.state === 'error'}
							<span class="hc-status hc-status--pill" data-s="error"><span class="hc-dot"></span>Error</span>
						{:else}
							<span class="hc-pmark faded" data-p={status.provider} aria-hidden="true">{providerMonogram(status.provider)}</span>
						{/if}
						<span>{problemText(status)}</span>
						<button class="hc-btn hc-btn--ghost hc-btn--sm" onclick={rescan} disabled={rescanning}>Rescan</button>
					</div>
				{/each}
				{#if !bannerDismissed}
					<div class="hc-float hc-banner">
						<span><b>Found {plural(agentsFound, 'agent')} · {plural(sessions.length, 'session')}.</b> <span class="muted">Group them by project, or drag cards into zones.</span></span>
						{#if zones.size === 0}
							<button class="hc-btn hc-btn--primary hc-btn--sm" onclick={groupByProject}><Icon name="group" size={13} />Group by project</button>
						{/if}
						<button class="hc-iconbtn small" onclick={dismissBanner} aria-label="Dismiss" title="Dismiss"><Icon name="x" /></button>
					</div>
				{/if}
			</div>
		{/if}
	{/if}

	<header class="hc-topbar top">
		<span class="hc-brand">
			<svg class="hc-brand__mark" viewBox="0 0 18 18" aria-hidden="true">
				<rect width="18" height="18" rx="5" class="mark-tile" />
				<path d="M5 11.6a4 4 0 0 1 8 0M3.8 11.6h10.4M6 14h6" class="mark-sun" />
			</svg>
			Halcyon
		</span>
		<span class="hc-sep brand-sep"></span>
		<span class="hc-ws workspace">Default workspace</span>
		<div class="hc-spacer"></div>
		{#if workspaceReady && sessions.length}
			<TagFilter
				bind:this={tagFilter}
				tags={filterTags}
				counts={tagCounts}
				mode={filterMode}
				bind:text={filterText}
				canCreateZone={!!filterView && filterView.matches.size > 0}
				onchange={(tags) => (filterTags = tags)}
				onmode={(mode) => (filterMode = mode)}
				oncreatezone={zoneFromFilter}
				onexit={() => {}}
			/>
			<div class="hc-spacer"></div>
		{/if}

		{#if providers.length}
			<ul class="providers" aria-label="Agents">
				{#each providers as status (status.provider)}
					<li class="provider" data-state={status.health.state} title={healthSummary(status)}>
						<span class="hc-pmark" data-p={status.provider} aria-hidden="true">{providerMonogram(status.provider)}</span>
						<span class="sr-only">{healthSummary(status)}</span>
						<span aria-hidden="true">
							{#if status.health.state === 'ok'}
								{status.health.sessionCount}
							{:else if status.health.state === 'error'}
								<span class="hc-status" data-s="error"><span class="hc-dot"></span></span>
							{:else}
								—
							{/if}
						</span>
					</li>
				{/each}
			</ul>
			<span class="hc-sep providers-sep"></span>
		{/if}

		<button class="hc-iconbtn" onclick={rescan} disabled={rescanning} aria-label="Rescan sessions" title="Rescan"><Icon name="refresh" /></button>
		<button
			class="hc-iconbtn"
			onclick={toggleTheme}
			aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
			title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
		>
			<Icon name={theme === 'dark' ? 'sun' : 'moon'} />
		</button>
		<button class="hc-iconbtn menu-btn" onclick={() => (menuOpen = !menuOpen)} aria-label="More" aria-expanded={menuOpen} title="More">
			<Icon name="more" />
		</button>
	</header>

	{#if menuOpen}
		<div class="hc-pop menu" role="menu">
			<button class="hc-pop__row" role="menuitem" onclick={groupByProject}>
				<Icon name="group" />Group by project <span class="n">zones per repo</span>
			</button>
			<div class="divider"></div>
			<button
				class="hc-pop__row"
				role="menuitemcheckbox"
				aria-checked={scrollZooms}
				onclick={() => {
					scrollZooms = !scrollZooms;
					writePref('scrollZooms', scrollZooms);
				}}
			>
				Scroll wheel zooms <span class="n">{scrollZooms ? 'On' : 'Off'}</span>
			</button>
			<button
				class="hc-pop__row"
				role="menuitemcheckbox"
				aria-checked={gridOn}
				onclick={() => {
					gridOn = !gridOn;
					writePref('grid', gridOn);
				}}
			>
				Dot grid <span class="n">{gridOn ? 'On' : 'Off'}</span>
			</button>
			<div class="hc-pop__label">Shortcuts</div>
			<div class="keys">
				<span><kbd class="hc-kbd">Space</kbd> drag to pan</span>
				<span><kbd class="hc-kbd">⌘</kbd> scroll / pinch zoom</span>
				<span><kbd class="hc-kbd">1</kbd> fit all</span>
				<span><kbd class="hc-kbd">0</kbd> 100%</span>
				<span><kbd class="hc-kbd">F</kbd> focus selected</span>
				<span><kbd class="hc-kbd">Esc</kbd> close</span>
				<span><kbd class="hc-kbd">+</kbd> <kbd class="hc-kbd">−</kbd> zoom</span>
				<span><kbd class="hc-kbd">←↑→↓</kbd> next card</span>
				<span><kbd class="hc-kbd">/</kbd> filter</span>
				<span><kbd class="hc-kbd">N</kbd> new zone</span>
				<span>Double-click a card or zone name to rename</span>
			</div>
		</div>
	{/if}

	<div class="side" class:open={!!selected} inert={!selected}>
		{#if selected}
			<Sidebar
				session={selected}
				{now}
				name={titlesOf.get(selected.id) ?? null}
				onrename={(title) => renameSession(selected.id, title)}
				tags={tagsOf.get(selected.id) ?? []}
				zones={[...zones.values()]}
				zoneId={zoneOf.get(selected.id) ?? null}
				onclose={() => (selectedId = null)}
				ontags={(tags) => setTags(selected.id, tags)}
				onzone={(zoneId) => moveToZone(selected.id, zoneId)}
				ontoast={(message) => showToast(message)}
			/>
		{/if}
	</div>

	{#if toast}
		<div class="hc-float hc-banner toast" role="status">
			<span>{toast.message}</span>
			{#if toast.undo}<button class="hc-btn hc-btn--sm" onclick={runUndo}>Undo</button>{/if}
		</div>
	{/if}
</div>

<style>
	.app {
		position: fixed;
		inset: 0;
		overflow: hidden;
		background: var(--canvas);
		user-select: none;
	}
	/* Details, paths and messages stay selectable for copying. */
	.side,
	.hc-empty {
		user-select: text;
	}
	.top {
		position: absolute;
		inset: 0 0 auto 0;
		z-index: var(--z-chrome);
	}
	.mark-tile {
		fill: var(--accent);
	}
	.mark-sun {
		fill: none;
		stroke: var(--on-accent);
		stroke-width: 1.6;
		stroke-linecap: round;
	}
	.workspace {
		cursor: default;
	}
	.workspace:hover {
		background: transparent;
		color: var(--ink-muted);
	}
	.providers {
		display: flex;
		gap: var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.provider {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font: 450 12px/16px var(--font-sans);
		color: var(--ink-muted);
		font-variant-numeric: tabular-nums;
	}
	.provider[data-state='unavailable'] .hc-pmark,
	.faded {
		opacity: 0.4;
	}
	.hc-iconbtn[disabled] {
		opacity: 0.45;
		pointer-events: none;
	}
	.hc-iconbtn.small {
		width: 24px;
		height: 24px;
	}

	.menu {
		position: absolute;
		top: 48px;
		right: 8px;
		z-index: var(--z-panel);
		width: 300px;
	}
	.menu button.hc-pop__row {
		width: 100%;
		border: 0;
		background: transparent;
		text-align: left;
	}
	.keys {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 6px 12px;
		padding: 4px 8px 8px;
		font-size: 12px;
		color: var(--ink-muted);
	}
	.keys span {
		white-space: nowrap;
	}
	.keys span:last-child {
		grid-column: 1 / -1;
	}
	.menu .divider {
		height: 1px;
		background: var(--border);
		margin: 4px;
	}

	.banners {
		position: absolute;
		top: calc(var(--topbar-height) + 12px);
		left: 50%;
		transform: translateX(-50%);
		z-index: var(--z-chrome);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-2);
		max-width: calc(100% - 32px);
	}
	.banners b {
		font-weight: 600;
	}
	.muted {
		color: var(--ink-muted);
	}
	.toast {
		position: absolute;
		bottom: 16px;
		left: 50%;
		transform: translateX(-50%);
		z-index: var(--z-panel);
		padding-right: 6px;
		min-height: 36px;
	}
	.toast span:only-child {
		padding-right: 6px;
	}

	.side {
		position: absolute;
		top: calc(var(--topbar-height) + 8px);
		right: 8px;
		bottom: 8px;
		width: var(--sidebar-width);
		z-index: var(--z-panel);
		transform: translateX(calc(100% + 16px));
		visibility: hidden;
		transition:
			transform var(--dur-panel) var(--ease-out),
			visibility 0s linear var(--dur-panel);
	}
	.side.open {
		transform: none;
		visibility: visible;
		transition-delay: 0s;
	}

	.center {
		position: absolute;
		inset: var(--topbar-height) 0 0 0;
		display: grid;
		place-items: center;
		padding: var(--space-4);
	}
	.dotted {
		background-image: radial-gradient(circle at 1px 1px, var(--canvas-dot) 1px, transparent 1.2px);
		background-size: var(--space-4) var(--space-4);
	}
	.hc-empty h2 {
		font: 600 24px/30px var(--font-sans);
		letter-spacing: -0.02em;
	}
	.actions {
		display: flex;
		gap: var(--space-2);
		margin-top: var(--space-2);
	}
	.commands {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		width: 100%;
		text-align: left;
	}
	.art-card {
		fill: var(--surface);
		stroke: var(--border-strong);
	}
	.art-dashed {
		stroke-dasharray: 4 3;
	}
	.art-dot {
		fill: var(--status-idle);
	}
	.art-line {
		stroke: var(--border-strong);
		stroke-width: 1.6;
		stroke-linecap: round;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	@media (max-width: 760px) {
		.side {
			left: 8px;
			width: auto;
		}
		.workspace,
		.brand-sep,
		.providers,
		.providers-sep {
			display: none;
		}
	}
</style>
