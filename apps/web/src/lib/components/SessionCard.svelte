<script lang="ts">
	import type { Session } from '@halcyon/core';
	import type { CardStatus } from '#lib/live.js';
	import LiveStatus from './LiveStatus.svelte';
	import { displayPath, displayTitle, exactTime, plural, providerLabel, providerMonogram, relativeTime } from '#lib/format.js';

	let {
		session,
		title: customTitle = null,
		renaming = false,
		onrename = () => {},
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
		hidden = false,
		isArchived = false,
		status = null
	}: {
		session: Session;
		/** Display name given in Halcyon; overrides the provider title. */
		title?: string | null;
		renaming?: boolean;
		/** New name, empty string to reset, or null to cancel. */
		onrename?: (title: string | null) => void;
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
		isArchived?: boolean;
		/** Live state from the provider's own signal; null when it can't tell. */
		status?: CardStatus | null;
	} = $props();
	const live = $derived(status && status !== 'closed' ? status : null);
	// Closed (or unknown) sessions fade gently with inactivity: 0 today, about
	// 0.6 after a week, 1 after a month. Live sessions never fade.
	const fade = $derived.by(() => {
		if (live || !session.lastActivityAt) return 0;
		const days = Math.max(0, (now - Date.parse(session.lastActivityAt)) / 86_400_000);
		return Math.round(Math.min(1, Math.log2(1 + days) / Math.log2(31)) * 100) / 100;
	});

	const title = $derived(customTitle ?? displayTitle(session));
	const named = $derived(!!customTitle || !!session.title);

	let input = $state<HTMLInputElement>();
	let done = false;
	$effect(() => {
		if (renaming && input) {
			done = false;
			input.focus();
			input.select();
		}
	});
	function finish(value: string | null) {
		if (done) return;
		done = true;
		onrename(value);
	}
	const time = $derived(relativeTime(session.lastActivityAt, now));
	const path = $derived(session.latestPath ?? session.projectPath);
	// Tags matching the active filter come first so they are never hidden behind +N.
	const ordered = $derived([...tags.filter((t) => activeTags.includes(t)), ...tags.filter((t) => !activeTags.includes(t))]);
</script>

<!-- A status word appears only for a running session, from the provider's own signal; otherwise the
     card shows turns. The slot carries the canvas position; the card keeps the design system's own hover/drag transforms. -->
<div class="slot" class:is-dragging={dragging} class:hidden data-slot={session.id} style:transform="translate({x}px, {y}px)">
	<div
		class="hc-card"
		class:is-selected={selected}
		class:is-dragging={dragging}
		class:is-compact={compact}
		class:is-highlighted={highlighted}
		class:is-dimmed={dimmed}
		class:archived={isArchived}
		data-live={live ?? 'none'}
		style:--fade={fade}
		data-id={session.id}
		role="button"
		tabindex="0"
		aria-pressed={selected}
		aria-label={`${title}, ${providerLabel(session.provider)}${status ? `, ${status === 'waiting' ? 'needs input' : status}` : ''}, last active ${time}`}
	>
		<div class="hc-card__head">
			<span class="hc-pmark" data-p={session.provider} title={providerLabel(session.provider)}>{providerMonogram(session.provider)}</span>
			{#if isArchived}<span class="hc-chip hc-chip--count archived-chip">Archived</span>{/if}
			{#if renaming}
				<input
					bind:this={input}
					class="rename"
					value={title}
					maxlength="120"
					aria-label="Session name"
					onkeydown={(e) => {
						e.stopPropagation();
						if (e.key === 'Enter') finish(e.currentTarget.value);
						if (e.key === 'Escape') finish(null);
					}}
					onblur={(e) => finish(e.currentTarget.value)}
				/>
			{:else}
				<span class="hc-card__title" class:untitled={!named} title={`${title} · double-click to rename`}>{title}</span>
			{/if}
		</div>
		<div class="hc-card__path" title={path ?? undefined}>{displayPath(path) ?? 'Unknown folder'}</div>
		{#if compact && live}
			<div class="hc-card__row"><LiveStatus status={live} /></div>
		{/if}
		{#if !compact}
			<div class="hc-card__row">
				{#if live}
					<LiveStatus status={live} />
				{:else}
					<span class="turns">{session.userTurnCount === null ? '— turns' : plural(session.userTurnCount, 'turn')}</span>
				{/if}
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
	/* Border carries live state: working green, needs input amber (the loud one),
	   open or idle a quiet teal. Selection, highlight and drag keep their own look. */
	.hc-card:not(.is-selected):not(.is-highlighted):not(.is-dragging)[data-live='working'] {
		border-color: var(--status-working);
	}
	.hc-card:not(.is-selected):not(.is-highlighted):not(.is-dragging)[data-live='waiting'] {
		border-color: var(--status-waiting);
		box-shadow: 0 0 0 1px var(--status-waiting), var(--shadow-card);
	}
	.hc-card:not(.is-selected):not(.is-highlighted):not(.is-dragging)[data-live='idle'],
	.hc-card:not(.is-selected):not(.is-highlighted):not(.is-dragging)[data-live='open'] {
		border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
	}
	/* Not running: border and title fade with days since last activity. */
	.hc-card:not(.is-selected):not(.is-highlighted)[data-live='none'] {
		border-color: color-mix(in srgb, var(--border) calc(100% - var(--fade) * 45%), transparent);
	}
	.hc-card[data-live='none'] .hc-card__title:not(.untitled) {
		color: color-mix(in srgb, var(--ink-muted) calc(var(--fade) * 100%), var(--ink));
	}
	.hc-card.archived {
		opacity: 0.6;
		border-style: dashed;
		box-shadow: none;
	}
	.archived-chip {
		order: 3;
		flex: none;
	}
	.rename {
		flex: 1;
		min-width: 0;
		font: 550 13px/18px var(--font-sans);
		color: var(--ink);
		background: var(--surface);
		border: 0;
		outline: 1.5px solid var(--accent);
		outline-offset: 1px;
		border-radius: 3px;
		padding: 0 2px;
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
