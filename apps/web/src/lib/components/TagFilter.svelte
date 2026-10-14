<script lang="ts">
	import Icon from './Icon.svelte';

	let {
		tags,
		counts,
		mode,
		text = $bindable(''),
		canCreateZone,
		onchange,
		onmode,
		oncreatezone,
		onexit
	}: {
		/** Active filter tags. */
		tags: string[];
		/** All tags in use, with session counts, most used first. */
		counts: [string, number][];
		mode: 'highlight' | 'only';
		/** Free text matched against names, folders and tags. */
		text?: string;
		canCreateZone: boolean;
		onchange: (tags: string[]) => void;
		onmode: (mode: 'highlight' | 'only') => void;
		oncreatezone: () => void;
		/** Focus leaves the filter (Esc with nothing to clear). */
		onexit: () => void;
	} = $props();

	let input = $state<HTMLInputElement>();
	// The typed text both suggests tags and filters by name/folder.
	const query = $derived(text);
	let open = $state(false);
	let active = $state(0);

	const options = $derived.by(() => {
		const q = query.trim().replace(/^#/, '').toLowerCase();
		return counts.filter(([t]) => !tags.includes(t) && t.includes(q)).slice(0, 8);
	});
	$effect(() => {
		if (active >= options.length) active = Math.max(0, options.length - 1);
	});

	export function focus() {
		input?.focus();
	}
	function add(tag: string) {
		if (!tags.includes(tag)) onchange([...tags, tag]);
		text = '';
		active = 0;
	}
	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			active = Math.min(active + 1, options.length - 1);
			event.preventDefault();
		} else if (event.key === 'ArrowUp') {
			active = Math.max(active - 1, 0);
			event.preventDefault();
		} else if (event.key === 'Enter') {
			const option = options[active];
			if (option) add(option[0]);
			event.preventDefault();
		} else if (event.key === 'Backspace' && query === '' && tags.length) {
			onchange(tags.slice(0, -1));
		} else if (event.key === 'Escape') {
			event.stopPropagation();
			if (tags.length || text) {
				text = '';
				onchange([]);
			}
			input?.blur();
			onexit();
		}
	}
</script>

<div class="wrap">
	<div class="hc-filter">
		<Icon name="search" />
		{#if tags.length}
			<div class="hc-filter__chips">
				{#each tags as tag (tag)}
					<span class="hc-chip hc-chip--active">
						{tag}
						<button class="hc-x" onclick={() => onchange(tags.filter((t) => t !== tag))} aria-label={`Remove ${tag} from filter`}>
							<Icon name="x" size={10} />
						</button>
					</span>
				{/each}
			</div>
		{/if}
		<input
			bind:this={input}
			bind:value={text}
			placeholder={tags.length ? '' : 'Filter by tag, name or folder'}
			aria-label="Filter by tag, name or folder"
			autocomplete="off"
			role="combobox"
			aria-expanded={open}
			aria-controls="tag-options"
			onfocus={() => (open = true)}
			onblur={() => setTimeout(() => (open = false), 100)}
			oninput={() => (active = 0)}
			{onkeydown}
		/>
		{#if tags.length || text.trim()}
			<div class="hc-seg" role="group" aria-label="Filter mode">
				<button aria-pressed={mode === 'highlight'} onclick={() => onmode('highlight')}>Highlight</button>
				<button aria-pressed={mode === 'only'} onclick={() => onmode('only')}>Only</button>
			</div>
			<button
				class="hc-iconbtn clear"
				onclick={() => {
					text = '';
					onchange([]);
				}}
				aria-label="Clear filter"
				title="Clear filter (Esc)"
			>
				<Icon name="x" />
			</button>
		{/if}
	</div>

	{#if open}
		<div class="hc-pop pop" id="tag-options" role="listbox">
			<div class="hc-pop__label">Tags</div>
			{#if options.length}
				{#each options as [tag, n], i (tag)}
					<div
						class="hc-pop__row"
						class:is-active={i === active}
						role="option"
						aria-selected={i === active}
						tabindex="-1"
						onmousedown={(e) => {
							e.preventDefault();
							add(tag);
						}}
					>
						<span class="hc-chip">{tag}</span><span class="n">{n}</span>
					</div>
				{/each}
			{:else}
				<div class="hc-pop__row quiet">
					{text.trim() ? 'Showing sessions whose name or folder matches' : counts.length ? 'No more tags' : 'No tags yet. Add them in a session’s details.'}
				</div>
			{/if}
			{#if tags.length && canCreateZone}
				<div class="divider"></div>
				<div
					class="hc-pop__row"
					role="option"
					aria-selected="false"
					tabindex="-1"
					onmousedown={(e) => {
						e.preventDefault();
						input?.blur();
						oncreatezone();
					}}
				>
					<Icon name="zone" />Create zone from {tags.map((t) => `#${t}`).join(' + ')}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.wrap {
		position: relative;
		flex: 0 1 460px;
		min-width: 0;
		display: flex;
		justify-content: center;
	}
	.hc-filter {
		width: 100%;
		min-width: 220px;
	}
	.hc-filter__chips .hc-chip {
		height: 22px;
	}
	.clear {
		width: 24px;
		height: 24px;
	}
	.pop {
		position: absolute;
		top: 36px;
		left: 0;
		right: 0;
		min-width: 240px;
		z-index: calc(var(--z-panel) + 10);
	}
	.quiet {
		color: var(--ink-subtle);
		cursor: default;
	}
	.quiet:hover {
		background: transparent;
	}
	.divider {
		height: 1px;
		background: var(--border);
		margin: 4px;
	}
	@media (max-width: 760px) {
		.hc-filter {
			min-width: 0;
		}
		.hc-seg {
			display: none;
		}
	}
</style>
