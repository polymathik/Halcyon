<script lang="ts">
	import type { Zone } from '@halcyon/core';
	import Icon from './Icon.svelte';

	let {
		zone,
		count,
		drop = false,
		renaming = false,
		onrename
	}: {
		zone: Zone;
		count: number;
		drop?: boolean;
		renaming?: boolean;
		/** Called with the new name, or null when renaming is cancelled. */
		onrename: (name: string | null) => void;
	} = $props();

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
</script>

<div
	class="hc-zone"
	class:is-drop={drop}
	data-zone={zone.id}
	data-c={zone.color}
	style:transform="translate({zone.x}px, {zone.y}px)"
	style:width="{zone.width}px"
	style:height="{zone.height}px"
>
	<div class="hc-zone__label" title="Drag to move · double-click to rename">
		{#if renaming}
			<input
				bind:this={input}
				class="rename"
				value={zone.name}
				aria-label="Zone name"
				maxlength="80"
				onkeydown={(e) => {
					e.stopPropagation();
					if (e.key === 'Enter') finish(e.currentTarget.value);
					if (e.key === 'Escape') finish(null);
				}}
				onblur={(e) => finish(e.currentTarget.value)}
				onpointerdown={(e) => e.stopPropagation()}
			/>
		{:else}
			<span class="name">{zone.name}</span>
		{/if}
		<span class="hc-zone__count">{count}</span>
	</div>
	<div class="hc-zone__menu tools">
		<button class="hc-iconbtn" data-action="rename-zone" aria-label={`Rename zone ${zone.name}`} title="Rename (or double-click the name)">
			<Icon name="pencil" />
		</button>
		<button class="hc-iconbtn" data-action="delete-zone" aria-label={`Delete zone ${zone.name}`} title="Delete zone">
			<Icon name="x" />
		</button>
	</div>
	<div class="hc-zone__handle" title="Resize"></div>
</div>

<style>
	.hc-zone {
		position: absolute;
		left: 0;
		top: 0;
		z-index: var(--z-zone);
	}
	.tools {
		position: absolute;
		right: 6px;
		top: 6px;
		display: flex;
		gap: 2px;
	}
	.tools .hc-iconbtn {
		width: 24px;
		height: 24px;
	}
	/* Height follows the cards; the handle sets width (columns). */
	.hc-zone__handle {
		cursor: ew-resize;
	}
	.hc-zone:focus-within .hc-zone__menu {
		opacity: 1;
	}
	.rename {
		font: inherit;
		color: var(--ink);
		background: var(--surface);
		border: 0;
		outline: 1.5px solid var(--accent);
		outline-offset: 2px;
		border-radius: 3px;
		padding: 0 2px;
		width: 160px;
		cursor: text;
	}
	:global(.lod) .hc-zone__label {
		font-size: calc(12px * var(--lod));
		line-height: 1.2;
	}
	:global(.lod) .hc-zone__count,
	:global(.lod) .hc-zone__menu,
	:global(.lod) .hc-zone__handle {
		display: none;
	}
</style>
