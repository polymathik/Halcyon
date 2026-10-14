<script lang="ts">
	import type { ProviderStatus } from '@halcyon/core';
	import { displayTitle, projectName, providerLabel, relativeTime } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const sessions = $derived(
		[...(data.sessions?.sessions ?? [])].sort((a, b) =>
			(b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '')
		)
	);

	function healthText(status: ProviderStatus): string {
		const { health } = status;
		if (health.state === 'ok') {
			return health.sessionCount === 0
				? 'No sessions found'
				: `${health.sessionCount} session${health.sessionCount === 1 ? '' : 's'}`;
		}
		if (health.state === 'unavailable') return health.reason;
		return `Scan failed: ${health.message}`;
	}
</script>

<header>
	<h1>Halcyon</h1>
	{#if data.sessions}
		<ul class="providers" aria-label="Providers">
			{#each data.sessions.providers as status (status.provider)}
				<li class={status.health.state} data-provider={status.provider}>
					<span class="dot" aria-hidden="true"></span>
					<strong>{status.displayName}</strong>
					<span>{healthText(status)}</span>
				</li>
			{/each}
		</ul>
	{/if}
</header>

<main>
	{#if data.error}
		<p class="notice danger">Halcyon's local server did not respond ({data.error}). Is <code>halcyon</code> running?</p>
	{:else if data.sessions && data.sessions.providers.length === 0}
		<p class="notice">No session providers are configured.</p>
	{:else if sessions.length === 0}
		<p class="notice">No sessions found yet. Start a Claude Code or Codex session and refresh.</p>
	{:else}
		<ul class="cards" aria-label="Sessions">
			{#each sessions as session (session.id)}
				<li class="card" data-provider={session.provider}>
					<span class="provider">{providerLabel(session.provider)}</span>
					<h2 class:untitled={!session.title}>{displayTitle(session)}</h2>
					<dl>
						<div><dt>Project</dt><dd title={session.projectPath ?? undefined}>{projectName(session.projectPath) ?? 'Unknown'}</dd></div>
						<div>
							<dt>Last activity</dt>
							<dd title={session.lastActivityAt ?? undefined}>{relativeTime(session.lastActivityAt)}</dd>
						</div>
						<div><dt>Turns</dt><dd>{session.userTurnCount ?? '—'}</dd></div>
					</dl>
				</li>
			{/each}
		</ul>
	{/if}
</main>

<style>
	header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 1rem 2rem;
		padding: 1rem 1.5rem;
		border-bottom: 1px solid var(--border);
	}
	h1 {
		margin: 0;
		font-size: 1.1rem;
		letter-spacing: 0.02em;
	}
	.providers {
		display: flex;
		flex-wrap: wrap;
		gap: 1.25rem;
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: 0.85rem;
		color: var(--muted);
	}
	.providers li {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.providers strong {
		color: var(--text);
		font-weight: 600;
	}
	.dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: var(--muted);
	}
	.ok .dot {
		background: #2f9e66;
	}
	.unavailable .dot {
		background: var(--warn);
	}
	.error .dot {
		background: var(--danger);
	}
	main {
		padding: 1.5rem;
	}
	.notice {
		max-width: 40rem;
		color: var(--muted);
	}
	.notice.danger {
		color: var(--danger);
	}
	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
		gap: 1rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.card {
		padding: 0.9rem 1rem;
		border: 1px solid var(--border);
		border-left: 3px solid var(--accent-claude);
		border-radius: 8px;
		background: var(--surface);
	}
	.card[data-provider='codex'] {
		border-left-color: var(--accent-codex);
	}
	.provider {
		font-size: 0.7rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--muted);
	}
	h2 {
		margin: 0.25rem 0 0.75rem;
		font-size: 0.98rem;
		line-height: 1.3;
		overflow-wrap: anywhere;
	}
	h2.untitled {
		color: var(--muted);
		font-weight: 500;
	}
	dl {
		display: grid;
		gap: 0.25rem;
		margin: 0;
		font-size: 0.8rem;
	}
	dl div {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
	}
	dt {
		color: var(--muted);
	}
	dd {
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
