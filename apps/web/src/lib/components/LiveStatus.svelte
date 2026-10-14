<script lang="ts">
	import { STATUS_LABEL, type CardStatus } from '#lib/live.js';

	let { status, label = STATUS_LABEL[status] }: { status: CardStatus; label?: string } = $props();
</script>

<!-- Design system status: colour is always paired with a word; only Needs input gets the pill. -->
<span class="hc-status" class:hc-status--pill={status === 'waiting'} data-s={status}><span class="hc-dot"></span>{label}</span>

<style>
	/* Open (process running, no detail) and Closed are Halcyon additions built from the idle token. */
	.hc-status[data-s='open'] {
		--sc: var(--status-idle);
	}
	.hc-status[data-s='closed'] {
		--sc: transparent;
		color: var(--ink-subtle);
	}
	.hc-status[data-s='closed'] .hc-dot {
		display: none;
	}
</style>
