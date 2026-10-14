<script lang="ts" module>
	// 16px, 1.6px stroke, round caps: the design system's icon set.
	const PATHS = {
		plus: '<path d="M8 3v10M3 8h10"/>',
		minus: '<path d="M3 8h10"/>',
		x: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
		zone: '<rect x="2" y="3" width="12" height="10" rx="2.5"/><path d="M2 6.5h5"/>',
		search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>',
		play: '<path d="M5 3.5v9l7.5-4.5z" fill="currentColor"/>',
		folder: '<path d="M2 4.5C2 3.7 2.7 3 3.5 3h2.8l1.5 1.5h4.7c.8 0 1.5.7 1.5 1.5v5.5c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5z"/>',
		check: '<path d="M3.5 8.5 6.5 11.5 12.5 4.5"/>',
		fit: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>',
		moon: '<path d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1z"/>',
		sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1"/>',
		more: '<path d="M3.5 8h.01M8 8h.01M12.5 8h.01" stroke-width="2.4"/>',
		refresh: '<path d="M13.2 8.5A5.2 5.2 0 1 1 11.6 4.3M13 2.5v3.3H9.7"/>',
		copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.8"/><path d="M10.5 3.2A1.4 1.4 0 0 0 9.2 2.5H4a1.5 1.5 0 0 0-1.5 1.5v5.2c0 .6.3 1.1.8 1.3"/>'
	} as const;
	export type IconName = keyof typeof PATHS;
</script>

<script lang="ts">
	let { name, size = 16 }: { name: IconName; size?: number } = $props();
</script>

<svg class="hc-icon" viewBox="0 0 16 16" width={size} height={size} style:width="{size}px" style:height="{size}px" aria-hidden="true">
	{@html PATHS[name]}
</svg>
