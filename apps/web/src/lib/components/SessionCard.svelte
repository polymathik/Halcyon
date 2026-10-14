<script lang="ts">
	import type { Session } from '@halcyon/core';
	import { displayPath, displayTitle, exactTime, plural, providerLabel, providerMonogram, relativeTime } from '#lib/format.js';

	let {
		session,
		x,
		y,
		now,
		selected = false,
		dragging = false,
		compact = false,
		tags = [],
		activeTags = [],
		highlighted = false,
		dimmed = false,
		hidden = false
	}: {
		session: Session;
		x: number;
		y: number;
		now: number;
		selected?: boolean;
		dragging?: boolean;
		compact?: boolean;
		tags?: string[];
		activeTags?: string[];
		highlighted?: boolean;
		dimmed?: boolean;
		hidden?: boolean;
	} = $props();

	const title = $derived(displayTitle(session));
	const time = $derived(relativeTime(session.lastActivityAt, now));
	const path = $derived(session.latestPath ?? session.projectPath);
	// Tags matching the active filter come first so they are never hidden behind +N.
	const ordered = $derived([...tags.filter((t) => activeTags.includes(t)), ...tags.filter((t) => !activeTags.includes(t))]);
</script>

<!-- Live status is not verified yet, so the card shows turns and last activity, never a status word.
     The slot carries the canvas position; the card keeps the design system's own hover/drag transforms. -->
<div class="slot" class:is-dragging={dragging} class:hidden data-slot={session.id} style:transform="translate({x}px, {y}px)">
	<div
		class="hc-card"
		class:is-selected={selected}
		class:is-dragging={dragging}
		class:is-compact={compact}
		class:is-highlighted={highlighted}
		class:is-dimmed={dimmed}
		data-id={session.id}
		role="button"
		tabindex="0"
		aria-pressed={selected}
		aria-label={`${title}, ${providerLabel(session.provider)}, last active ${time}`}
	>
		<div class="hc-card__head">
			<span class="hc-pmark" data-p={session.provider} title={providerLabel(session.provider)}>{providerMonogram(session.provider)}</span>
			<span class="hc-card__title" class:untitled={!session.title} title={title}>{title}</span>
		</div>
		<div class="hc-card__path" title={path ?? undefined}>{displayPath(path) ?? 'Unknown folder'}</div>
		{#if !compact}
			<div class="hc-card__row">
				<span class="turns">{session.userTurnCount === null ? '— turns' : plural(session.userTurnCount, 'turn')}</span>
				<time class="hc-card__time" datetime={session.lastActivityAt ?? undefined} title={exactTime(session.lastActivityAt)}>{time}</time>
			</div>
			{#if tags.length}
				<div class="hc-card__tags">
					{#each ordered.slice(0, 2) as tag (tag)}
						<span class="hc-chip" class:hc-chip--active={activeTags.includes(tag)}>{tag}</span>
					{/each}
					{#if tags.length > 2}<span class="hc-chip hc-chip--count" title={ordered.slice(2).join(', ')}>+{tags.length - 2}</span>{/if}
				</div>
			{/if}
		{/if}
	</div>
</div>

<style>
	.slot {
		position: absolute;
		left: 0;
		top: 0;
		z-index: var(--z-card);
	}
	.slot.hidden {
		display: none;
	}
	/* Only the card in hand gets its own layer; 200+ layers would re-raster on every zoom step. */
	.slot.is-dragging {
		will-change: transform;
		z-index: var(--z-drag);
	}
	.hc-card {
		cursor: pointer;
	}
	/* Compact level of detail: the provider tile counter-scales with the title. */
	.hc-card.is-compact .hc-pmark {
		width: calc(var(--provider-mark) * var(--lod, 1));
		height: calc(var(--provider-mark) * var(--lod, 1));
		font-size: calc(10px * var(--lod, 1));
		border-radius: calc(var(--radius-sm) * var(--lod, 1));
	}
	.hc-card__title.untitled {
		color: var(--ink-muted);
		font-weight: 500;
	}
	.turns {
		font: 450 12px/16px var(--font-sans);
		color: var(--ink-muted);
		font-variant-numeric: tabular-nums;
	}
</style>
