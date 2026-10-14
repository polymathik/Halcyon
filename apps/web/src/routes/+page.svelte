<script lang="ts">
	import { ZONE_COLORS, type ProviderStatus, type Session, type TagsResponse, type Zone, type ZoneInput } from '@halcyon/core';
	import { onMount } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { invalidateAll } from '$app/navigation';
	import { api } from '#lib/api.js';
	import {
		CARD_HEIGHT,
		CARD_HEIGHT_TAGGED,
		CARD_WIDTH,
		ZONE_LABEL_SPACE,
		ZONE_PAD,
		zoneGrid,
		type Camera,
		type Point
	} from '#lib/canvas/geometry.js';
	import { placeNew } from '#lib/canvas/layout.js';
	import Canvas from '#lib/components/Canvas.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import Sidebar from '#lib/components/Sidebar.svelte';
	import TagFilter from '#lib/components/TagFilter.svelte';
	import { plural, providerMonogram } from '#lib/format.js';
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

	// Sessions without a saved position are placed once, by project, below the
	// existing layout, and saved, so later discoveries never move existing cards.
	$effect(() => {
		if (!workspaceReady) return;
		const unplaced = sessions
			.filter((s) => !positions.has(s.id))
			.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
		if (unplaced.length === 0) return;
		const existing = [
			...[...positions.values()].map((p) => ({ ...p, w: CARD_WIDTH, h: CARD_HEIGHT })),
			...[...zones.values()].map((z) => ({ x: z.x, y: z.y, w: z.width, h: z.height }))
		];
		const placed = placeNew(
			unplaced.map((s) => ({ id: s.id, group: s.projectPath ?? '' })),
			existing
		);
		const batch: { sessionId: Session['id']; x: number; y: number }[] = [];
		for (const s of unplaced) {
			const p = placed.get(s.id);
			if (!p) continue;
			positions.set(s.id, p);
			batch.push({ sessionId: s.id, ...p });
		}
		api.savePlacements(batch).catch(saveFailed);
	});

	// ---------- filter ----------
	let filterTags = $state<string[]>([]);
	let filterMode = $state<'highlight' | 'only'>('highlight');
	let tagFilter = $state<TagFilter>();
	const presentIds = $derived(new Set<string>(sessions.map((s) => s.id)));
	const tagCounts = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const [id, list] of tagsOf) if (presentIds.has(id)) for (const t of list) counts.set(t, (counts.get(t) ?? 0) + 1);
		return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	});
	const filterView = $derived.by(() => {
		if (filterTags.length === 0) return null;
		const matches = new Set<string>();
		for (const s of sessions) if ((tagsOf.get(s.id) ?? []).some((t) => filterTags.includes(t))) matches.add(s.id);
		return { tags: filterTags, mode: filterMode, matches };
	});
	// The filter is saved with the workspace.
	$effect(() => {
		const saved = filterTags.length ? { tags: [...filterTags], mode: filterMode } : null;
		if (!workspaceReady) return;
		const timer = setTimeout(() => api.saveFilter(saved).catch(() => {}), 400);
		return () => clearTimeout(timer);
	});

	// ---------- layout changes from the canvas ----------
	const zoneName = (id: number | null) => (id === null ? null : (zones.get(id)?.name ?? null));
	const zoneInput = (z: Zone): ZoneInput => ({ name: z.name, color: z.color, x: z.x, y: z.y, width: z.width, height: z.height });
	const membersOf = (zoneId: number) => [...zoneOf].filter(([, z]) => z === zoneId).map(([id]) => id);

	function moved(id: string, p: Point, zoneId: number | null, previous: number | null) {
		zoneOf.set(id, zoneId);
		api.savePlacements([{ sessionId: id as Session['id'], x: p.x, y: p.y, zoneId }]).catch(saveFailed);
		if (zoneId !== previous) showToast(zoneId !== null ? `Moved to ${zoneName(zoneId)}` : 'Removed from zone');
	}

	function zoneChanged(zoneId: number, movedMembers: boolean) {
		const zone = zones.get(zoneId);
		if (!zone) return;
		const { name: _name, color: _color, ...geometry } = zoneInput(zone);
		api.updateZone(zoneId, geometry).catch(saveFailed);
		if (movedMembers) {
			const batch = membersOf(zoneId).flatMap((id) => {
				const p = positions.get(id);
				return p ? [{ sessionId: id as Session['id'], x: p.x, y: p.y }] : [];
			});
			if (batch.length) api.savePlacements(batch).catch(saveFailed);
		}
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
			width: 320,
			height: 200
		};
		try {
			const zone = await api.createZone(input);
			zones.set(zone.id, zone);
			renamingZone = zone.id;
		} catch {
			saveFailed();
		}
	}

	function deleteZone(zoneId: number) {
		const zone = zones.get(zoneId);
		if (!zone) return;
		const members = membersOf(zoneId);
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

	/** Move a session into a zone's next free grid slot, or out to the zone's right. */
	function moveToZone(id: string, zoneId: number | null) {
		const previous = zoneOf.get(id) ?? null;
		const p = positions.get(id);
		if (!p || zoneId === previous) return;
		let next: Point = p;
		if (zoneId !== null) {
			const zone = zones.get(zoneId);
			if (!zone) return;
			const index = membersOf(zoneId).length;
			const cols = Math.max(1, Math.floor((zone.width - ZONE_PAD) / (CARD_WIDTH + ZONE_PAD)));
			next = {
				x: zone.x + ZONE_PAD + (index % cols) * (CARD_WIDTH + ZONE_PAD),
				y: zone.y + ZONE_LABEL_SPACE + Math.floor(index / cols) * (CARD_HEIGHT_TAGGED + ZONE_PAD)
			};
			const needed = next.y + CARD_HEIGHT_TAGGED + ZONE_PAD - zone.y;
			if (needed > zone.height) {
				zones.set(zoneId, { ...zone, height: needed });
				api.updateZone(zoneId, { height: needed }).catch(saveFailed);
			}
		} else if (previous !== null) {
			const zone = zones.get(previous);
			if (zone) next = { x: zone.x + zone.width + 24, y: p.y };
		}
		positions.set(id, next);
		zoneOf.set(id, zoneId);
		api.savePlacements([{ sessionId: id as Session['id'], ...next, zoneId }]).catch(saveFailed);
		canvas?.focusOn(id);
		showToast(zoneId !== null ? `Moved to ${zoneName(zoneId)}` : 'Removed from zone');
	}

	async function zoneFromFilter() {
		const view = filterView;
		if (!view || !canvas) return;
		const hits = sessions.filter((s) => view.matches.has(s.id) && positions.has(s.id)).map((s) => s.id);
		if (hits.length === 0) {
			showToast('No sessions match this filter');
			return;
		}
		const before = hits.map((id) => ({ id, p: { ...positions.get(id)! }, zone: zoneOf.get(id) ?? null }));
		const area = canvas.contentBounds() ?? { x: 0, y: 0, w: 0, h: 0 };
		const origin = { x: Math.round(area.x + area.w + 80), y: Math.round(area.y) };
		const grid = zoneGrid(origin, hits.length, Math.min(3, Math.ceil(Math.sqrt(hits.length))));
		const name = view.tags.map((t) => `#${t}`).join(' + ').slice(0, 80);
		try {
			const zone = await api.createZone({ name, color: 'iris', x: origin.x, y: origin.y, width: grid.w, height: grid.h });
			zones.set(zone.id, zone);
			const batch = hits.map((id, i) => {
				const slot = grid.slots[i]!;
				positions.set(id, slot);
				zoneOf.set(id, zone.id);
				return { sessionId: id as Session['id'], ...slot, zoneId: zone.id };
			});
			await api.savePlacements(batch);
			canvas.fitBox({ x: zone.x, y: zone.y, w: zone.width, h: zone.height });
			showToast(`Moved ${plural(hits.length, 'session')} into ${name}`, async () => {
				for (const b of before) {
					positions.set(b.id, b.p);
					zoneOf.set(b.id, b.zone);
				}
				zones.delete(zone.id);
				await api.savePlacements(before.map((b) => ({ sessionId: b.id as Session['id'], ...b.p, zoneId: b.zone })));
				await api.deleteZone(zone.id);
				canvas?.fitAll();
			});
		} catch {
			saveFailed();
		}
	}

	async function setTags(id: string, tags: string[]) {
		const previous = tagsOf.get(id) ?? [];
		tagsOf.set(id, [...tags].sort());
		try {
			applyTags(await api.setTags(id, tags));
		} catch (error) {
			tagsOf.set(id, previous);
			showToast(error instanceof Error ? error.message : "Couldn't save tags");
		}
	}

	function cameraChanged(c: Camera) {
		api.saveViewport({ x: Math.round(c.x), y: Math.round(c.y), zoom: c.z }).catch(() => {
			// The view is a convenience; a failed save is not worth interrupting for.
		});
	}

	function escape() {
		if (renamingZone !== null) return;
		if (menuOpen) menuOpen = false;
		else if (selectedId) selectedId = null;
		else if (filterTags.length) filterTags = [];
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
						<span><b>Found {plural(agentsFound, 'agent')} · {plural(sessions.length, 'session')}.</b> <span class="muted">Drag cards into zones to organize.</span></span>
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
			</div>
		</div>
	{/if}

	<div class="side" class:open={!!selected} inert={!selected}>
		{#if selected}
			<Sidebar
				session={selected}
				{now}
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
