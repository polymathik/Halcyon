<script lang="ts">
	import favicon from '#lib/assets/favicon.svg';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Halcyon</title>
</svelte:head>

{@render children()}

<style>
	:global(:root) {
		color-scheme: light dark;
		--bg: #f6f5f2;
		--surface: #ffffff;
		--border: #e2dfd8;
		--text: #1d1c1a;
		--muted: #6b6760;
		--accent-claude: #c96442;
		--accent-codex: #3d6fd9;
		--warn: #b7791f;
		--danger: #c53030;
		font-family:
			ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
	}
	@media (prefers-color-scheme: dark) {
		:global(:root) {
			--bg: #161614;
			--surface: #201f1d;
			--border: #34322e;
			--text: #ecebe8;
			--muted: #9c978e;
		}
	}
	:global(body) {
		margin: 0;
		background: var(--bg);
		color: var(--text);
	}
</style>
