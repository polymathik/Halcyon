<script lang="ts">
	import '../app.css';
	import favicon from '#lib/assets/favicon.svg';
	import { applyStoredTheme } from '#lib/theme.js';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// SPA only (ssr = false), so this runs before the first paint of the page.
	applyStoredTheme();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Halcyon</title>
</svelte:head>

{@render children()}
