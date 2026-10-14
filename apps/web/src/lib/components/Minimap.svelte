<script lang="ts">
	import type { Zone } from '@halcyon/core';
	import { bounds, type Box, type Camera, type Point } from '#lib/canvas/geometry.js';

	let {
		cards,
		zones = [],
		dimmed = null,
		selected = null,
		selectedId,
		camera,
		viewport,
		onjump
	}: {
		cards: (Box & { id: string })[];
		zones?: Zone[];
		/** When set, cards not in this set are drawn faded (Highlight filter). */
		dimmed?: Set<string> | null;
		/** Multi-selection, drawn like the selected card. */
		selected?: Set<string> | null;
		selectedId: string | null;
		camera: Camera;
		/** Visible canvas size in px. */
		viewport: { w: number; h: number };
		onjump: (world: Point) => void;
	} = $props();

	const W = 168;
	const H = 108;
	const PAD = 6;

	const view = $derived<Box>({
		x: -camera.x / camera.z,
		y: -camera.y / camera.z,
		w: viewport.w / camera.z,
		h: viewport.h / camera.z
	});
	const map = $derived.by(() => {
		const b = bounds([...cards, ...zones.map((z) => ({ x: z.x, y: z.y, w: z.collapsed ? Math.min(z.width, 240) : z.width, h: z.collapsed ? 40 : z.height })), view]) ?? { x: 0, y: 0, w: 1, h: 1 };
		const k = Math.min((W - PAD * 2) / b.w, (H - PAD * 2) / b.h);
		return { k, ox: PAD + (W - PAD * 2 - b.w * k) / 2 - b.x * k, oy: PAD + (H - PAD * 2 - b.h * k) / 2 - b.y * k };
	});
	const r = (b: Box) => ({
		x: (map.ox + b.x * map.k).toFixed(1),
		y: (map.oy + b.y * map.k).toFixed(1),
		width: Math.max(1, b.w * map.k).toFixed(1),
		height: Math.max(1, b.h * map.k).toFixed(1)
	});

	function jump(event: PointerEvent) {
		const rect = (event.currentTarget as SVGElement).getBoundingClientRect();
		onjump({ x: (event.clientX - rect.left - map.ox) / map.k, y: (event.clientY - rect.top - map.oy) / map.k });
	}
</script>

<div class="hc-float hc-minimap" title="Minimap: click to jump">
	<svg width={W} height={H} role="img" aria-label="Minimap" onpointerdown={jump}>
		{#each zones as zone (zone.id)}
			<rect
				{...r({ x: zone.x, y: zone.y, w: zone.collapsed ? Math.min(zone.width, 240) : zone.width, h: zone.collapsed ? 40 : zone.height })}
				rx="2"
				class="zone"
				style:fill="var(--zone-{zone.color}-fill)"
				style:stroke="var(--zone-{zone.color})"
			/>
		{/each}
		{#each cards as card (card.id)}
			<rect {...r(card)} rx="1.5" class="card" class:sel={card.id === selectedId || !!selected?.has(card.id)} class:faded={dimmed !== null && !dimmed.has(card.id)} />
		{/each}
		<rect {...r(view)} rx="1.5" class="view" />
	</svg>
</div>

<style>
	svg {
		display: block;
		cursor: pointer;
	}
	.card {
		fill: var(--border-strong);
	}
	.zone {
		stroke-width: 1;
	}
	.card.faded {
		opacity: 0.35;
	}
	.card.sel {
		fill: var(--accent);
	}
	.view {
		fill: var(--scrim);
		stroke: var(--ink-subtle);
		stroke-width: 1;
	}
</style>
