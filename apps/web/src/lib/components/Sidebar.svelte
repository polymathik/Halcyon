<script lang="ts">
	import { normalizeTag, type PreviewMessage, type Session, type SessionCommandResponse, type Zone } from '@halcyon/core';
	import { api } from '#lib/api.js';
	import { displayPath, displayTitle, exactTime, plural, providerLabel, providerMonogram, relativeTime } from '#lib/format.js';
	import { isRunning, STATUS_LABEL, type CardStatus } from '#lib/live.js';
	import Icon from './Icon.svelte';
	import LiveStatus from './LiveStatus.svelte';

	let {
		session,
		now,
		name = null,
		onrename,
		isArchived = false,
		status = null,
		onarchive,
		tags,
		zones,
		zoneId,
		onclose,
		ontags,
		onzone,
		ontoast
	}: {
		session: Session;
		now: number;
		/** Display name given in Halcyon, if any. */
		name?: string | null;
		/** New name, empty string to reset, or null to cancel. */
		onrename: (title: string | null) => void;
		isArchived?: boolean;
		/** Live status; null when the provider can't tell. */
		status?: CardStatus | null;
		onarchive: (archived: boolean) => void;
		tags: string[];
		zones: Zone[];
		zoneId: number | null;
		onclose: () => void;
		ontags: (tags: string[]) => void;
		onzone: (zoneId: number | null) => void;
		ontoast: (message: string) => void;
	} = $props();
	const statusHelp: Record<CardStatus, string> = {
		working: `${STATUS_LABEL.working}: the agent is running a turn.`,
		waiting: `${STATUS_LABEL.waiting}: the agent is waiting for you, for example to approve a tool.`,
		idle: `${STATUS_LABEL.idle}: open in a terminal, waiting for your next prompt.`,
		open: `${STATUS_LABEL.open}: running in a terminal. This agent doesn't report more detail.`,
		closed: `${STATUS_LABEL.closed}: no running process holds this session.`
	};

	// ---------- tags ----------
	let tagInput = $state('');
	let tagError = $state<string | null>(null);
	function addTag() {
		const tag = normalizeTag(tagInput);
		if (!tagInput.trim()) return;
		if (!tag) {
			tagError = 'Use letters, numbers, - _ . / + (up to 40)';
			return;
		}
		tagError = null;
		tagInput = '';
		if (!tags.includes(tag)) ontags([...tags, tag]);
	}

	// ---------- native actions ----------
	let actions = $state<SessionCommandResponse | null>(null);
	let busy = $state<'resume' | 'open' | null>(null);
	let copied = $state(false);
	$effect(() => {
		const id = session.id;
		const controller = new AbortController();
		actions = null;
		api
			.command(id, controller.signal)
			.then((body) => (actions = body))
			.catch(() => {
				if (!controller.signal.aborted) actions = { sessionId: id as Session['id'], command: null, canResume: false, canOpenFolder: false };
			});
		return () => controller.abort();
	});
	async function resume() {
		busy = 'resume';
		try {
			await api.resume(session.id);
			ontoast('Resumed in a new terminal window');
		} catch (error) {
			ontoast(error instanceof Error ? error.message : "Couldn't resume");
		} finally {
			busy = null;
		}
	}
	async function openFolder() {
		busy = 'open';
		try {
			await api.openFolder(session.id);
		} catch (error) {
			ontoast(error instanceof Error ? error.message : "Couldn't open the folder");
		} finally {
			busy = null;
		}
	}
	async function copyCommand() {
		if (!actions?.command) return;
		try {
			await navigator.clipboard.writeText(actions.command);
			copied = true;
			setTimeout(() => (copied = false), 1500);
			ontoast('Command copied');
		} catch {
			ontoast('Copy failed. Select the command below and copy it.');
		}
	}

	type PreviewState =
		| { state: 'loading' }
		| { state: 'ready'; messages: PreviewMessage[] }
		| { state: 'error'; message: string };

	let preview = $state<PreviewState>({ state: 'loading' });

	// Read the preview on request only: when a session is opened, or when its
	// transcript has new activity. Nothing is stored beyond this component.
	const previewKey = $derived(`${session.id}|${session.lastActivityAt ?? ''}`);
	let shownFor = '';
	$effect(() => {
		// Depend on the key only: the session object is replaced on every poll.
		const key = previewKey;
		const id = key.slice(0, key.indexOf('|'));
		const controller = new AbortController();
		// Keep showing the previous messages while refreshing the same session.
		if (!shownFor.startsWith(`${id}|`)) preview = { state: 'loading' };
		api
			.preview(id, controller.signal)
			.then((body) => {
				preview = { state: 'ready', messages: body.messages };
				shownFor = key;
			})
			.catch((error: unknown) => {
				if (controller.signal.aborted) return;
				preview = { state: 'error', message: error instanceof Error ? error.message : 'Preview unavailable' };
				shownFor = key;
			});
		return () => controller.abort();
	});

	const original = $derived(displayTitle(session));
	const title = $derived(name ?? original);

	let editing = $state(false);
	let nameInput = $state<HTMLInputElement>();
	$effect(() => {
		if (editing && nameInput) {
			nameInput.focus();
			nameInput.select();
		}
	});
	// Close the editor when another session is selected.
	$effect(() => {
		void session.id;
		editing = false;
	});
	function finishName(value: string | null) {
		if (!editing) return;
		editing = false;
		onrename(value);
	}
	const assistantLabel = $derived(providerLabel(session.provider));
</script>

<aside class="hc-sidebar" aria-label="Session details">
	<div class="hc-sidebar__head">
		<span class="hc-pmark hc-pmark--lg" data-p={session.provider} title={providerLabel(session.provider)}>{providerMonogram(session.provider)}</span>
		<div class="head-text">
			{#if editing}
				<input
					bind:this={nameInput}
					class="name-input"
					value={title}
					maxlength="120"
					aria-label="Session name"
					onkeydown={(e) => {
						if (e.key === 'Enter') finishName(e.currentTarget.value);
						if (e.key === 'Escape') {
							e.stopPropagation();
							finishName(null);
						}
					}}
					onblur={(e) => finishName(e.currentTarget.value)}
				/>
			{:else}
				<h2 class="hc-sidebar__title" class:untitled={!name && !session.title}>
					<button class="title-btn" onclick={() => (editing = true)} title="Rename (Halcyon only)">
						{title}<span class="pencil" aria-hidden="true"><Icon name="pencil" size={13} /></span>
					</button>
				</h2>
			{/if}
			<div class="hc-sidebar__sub">
				<span class="hc-mono sub-path scroll" title={session.projectPath ?? undefined}>{displayPath(session.projectPath) ?? 'Unknown folder'}</span>
			</div>
		</div>
		<button
			class="hc-iconbtn"
			onclick={() => onarchive(!isArchived)}
			aria-label={isArchived ? 'Unarchive session' : 'Archive session'}
			title={isArchived ? 'Unarchive' : 'Archive (hide from the canvas; files are kept)'}
			aria-pressed={isArchived}
		>
			<Icon name="archive" />
		</button>
		<button class="hc-iconbtn" onclick={onclose} aria-label="Close details" title="Close (Esc)"><Icon name="x" /></button>
	</div>

	<div class="hc-sidebar__body">
		{#if isArchived}
			<div class="archived-note">
				<span>Archived. It's hidden from the canvas; its transcript is untouched.</span>
				<button class="hc-btn hc-btn--sm" onclick={() => onarchive(false)}>Unarchive</button>
			</div>
		{/if}
		<section>
			<h3 class="hc-sec__label">Details</h3>
			<dl class="hc-meta">
				{#if name}
					<dt>Original name</dt>
					<dd class="scroll" title={original}>{original} · <button class="link" onclick={() => onrename('')}>Reset</button></dd>
				{/if}
				<dt>Agent</dt>
				<dd>{providerLabel(session.provider)}</dd>
				<dt>Status</dt>
				<dd title={status ? statusHelp[status] : 'This agent does not report whether the session is running.'}>
					{#if status}<LiveStatus {status} />{:else}<span class="muted">Unknown</span>{/if}
				</dd>
				<dt>Last activity</dt>
				<dd title={exactTime(session.lastActivityAt)}>{session.lastActivityAt ? `${relativeTime(session.lastActivityAt, now)} ago`.replace('now ago', 'now') : '—'}</dd>
				<dt>Started</dt>
				<dd title={exactTime(session.startedAt)}>{session.startedAt ? exactTime(session.startedAt) : '—'}</dd>
				<dt>Turns</dt>
				<dd>{session.userTurnCount ?? '—'}</dd>
				<dt>Folder</dt>
				<dd class="hc-mono scroll" title={session.projectPath ?? undefined}>{displayPath(session.projectPath) ?? '—'}</dd>
				{#if session.latestPath}
					<dt>Now in</dt>
					<dd class="hc-mono scroll" title={session.latestPath}>{displayPath(session.latestPath)}</dd>
				{/if}
				{#if session.git}
					<dt>Repository</dt>
					<dd class="repo">
						{#if session.git.webUrl}
							<a class="link" href={session.git.webUrl} target="_blank" rel="noopener noreferrer" title={session.git.webUrl}>{session.git.name}<Icon name="external" size={11} /></a>
						{:else}
							{session.git.name}
						{/if}
					</dd>
					{#if session.git.remoteUrl}
						<dt>Remote</dt>
						<dd class="hc-mono scroll" title={session.git.remoteUrl}>{session.git.remoteUrl}</dd>
					{/if}
					<dt>Branch</dt>
					<dd class="hc-mono scroll" title="Checked out in the folder now">
						{#if session.git.branch}{session.git.detached ? `detached at ${session.git.branch}` : session.git.branch}{:else}<span class="muted">Unknown</span>{/if}
					</dd>
					{#if session.git.root !== session.projectPath}
						<dt>Repo folder</dt>
						<dd class="hc-mono scroll" title={session.git.root}>{displayPath(session.git.root)}</dd>
					{/if}
				{/if}
				{#if session.sessionBranch && session.sessionBranch !== session.git?.branch}
					<dt>Session branch</dt>
					<dd class="hc-mono scroll" title="The branch the agent recorded for this session">{session.sessionBranch}</dd>
				{/if}
				<dt>Session</dt>
				<dd class="hc-mono scroll" title={session.nativeId}>{session.nativeId}</dd>
			</dl>
		</section>

		<section aria-label="Actions">
			<div class="hc-actions">
				<button class="hc-btn hc-btn--primary" onclick={resume} disabled={!actions?.canResume || busy !== null} title={actions && !actions.canResume ? 'Resume in terminal is not available here. Copy the command instead.' : undefined}>
					<Icon name="play" size={13} />{busy === 'resume' ? 'Opening terminal' : 'Resume in terminal'}
				</button>
				<button class="hc-btn" onclick={openFolder} disabled={!actions?.canOpenFolder || busy !== null}><Icon name="folder" />Open folder</button>
				<button class="hc-btn" onclick={copyCommand} disabled={!actions?.command}><Icon name={copied ? 'check' : 'copy'} />{copied ? 'Copied' : 'Copy command'}</button>
			</div>
			{#if isRunning(status)}
				<p class="footnote">Already open in a terminal. Resuming starts a second copy of this session.</p>
			{/if}
			{#if actions?.command}
				<div class="hc-cmd cmd"><code class="scroll" title={actions.command}>{actions.command}</code></div>
			{:else if actions}
				<p class="footnote">This agent has no resume command Halcyon can run.</p>
			{/if}
		</section>

		<section>
			<h3 class="hc-sec__label">Tags</h3>
			<div class="hc-tags-edit">
				{#each tags as tag (tag)}
					<span class="hc-chip">
						{tag}
						<button class="hc-x" onclick={() => ontags(tags.filter((t) => t !== tag))} aria-label={`Remove tag ${tag}`} title="Remove">
							<Icon name="x" size={10} />
						</button>
					</span>
				{/each}
				<input
					bind:value={tagInput}
					placeholder="+ Add tag"
					aria-label="Add tag"
					maxlength="41"
					onkeydown={(e) => {
						if (e.key === 'Enter' || e.key === ',') {
							e.preventDefault();
							addTag();
						} else if (e.key === 'Backspace' && !tagInput && tags.length) {
							ontags(tags.slice(0, -1));
						}
					}}
					onblur={addTag}
				/>
			</div>
			{#if tagError}<p class="field-error">{tagError}</p>{/if}
		</section>

		<section>
			<h3 class="hc-sec__label"><label for="zone-select">Zone</label></h3>
			<select
				id="zone-select"
				class="hc-select"
				value={zoneId === null ? '' : String(zoneId)}
				onchange={(e) => onzone(e.currentTarget.value ? Number(e.currentTarget.value) : null)}
			>
				<option value="">No zone</option>
				{#each zones as zone (zone.id)}
					<option value={String(zone.id)}>{zone.name}</option>
				{/each}
			</select>
		</section>

		<section>
			<h3 class="hc-sec__label">
				Recent
				{#if preview.state === 'ready' && preview.messages.length}
					<span class="sec-note">{plural(preview.messages.length, 'message')}</span>
				{/if}
			</h3>
			{#if preview.state === 'loading'}
				<div class="hc-transcript"><p class="quiet">Reading recent messages</p></div>
			{:else if preview.state === 'error'}
				<div class="hc-transcript"><p class="quiet">Couldn't read this transcript. {preview.message}.</p></div>
			{:else if preview.messages.length === 0}
				<div class="hc-transcript"><p class="quiet">No messages yet</p></div>
			{:else}
				<div class="hc-transcript">
					{#each preview.messages as message, i (i)}
						<div class="hc-msg">
							<b>{message.role === 'user' ? 'You' : assistantLabel}</b>
							<span class="msg-text">{message.text}</span>
						</div>
					{/each}
				</div>
				<p class="footnote">Read from the transcript just now. Halcyon doesn't store it.</p>
			{/if}
		</section>

	</div>
</aside>

<style>
	.muted {
		color: var(--ink-muted);
	}
	.hc-sidebar {
		height: 100%;
		width: 100%;
	}
	.head-text {
		flex: 1;
		min-width: 0;
	}
	.hc-sidebar__title {
		overflow-wrap: anywhere;
	}
	.hc-sidebar__title.untitled {
		color: var(--ink-muted);
	}
	.title-btn {
		all: unset;
		cursor: text;
		border-radius: 4px;
	}
	.title-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.pencil {
		display: inline-flex;
		margin-left: 6px;
		vertical-align: -1px;
		color: var(--ink-subtle);
		opacity: 0;
		transition: opacity var(--dur-fast);
	}
	.title-btn:hover .pencil,
	.title-btn:focus-visible .pencil {
		opacity: 1;
	}
	.name-input {
		width: 100%;
		font: 600 15px/22px var(--font-sans);
		color: var(--ink);
		background: var(--surface);
		border: 1px solid var(--accent);
		border-radius: var(--radius-md);
		padding: 0 6px;
		outline: 0;
		box-shadow: 0 0 0 3px var(--accent-soft);
	}
	.archived-note {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		justify-content: space-between;
		padding: 8px 8px 8px 12px;
		border-radius: var(--radius-lg);
		background: var(--surface-sunken);
		font: 450 12px/16px var(--font-sans);
		color: var(--ink-muted);
	}
	.link {
		all: unset;
		color: var(--accent-ink);
		cursor: pointer;
		font-weight: 500;
	}
	.link:hover {
		text-decoration: underline;
	}
	.repo .link {
		display: inline-flex;
		align-items: center;
		gap: 3px;
	}
	.sub-path {
		display: block;
		color: var(--ink-muted);
		white-space: nowrap;
		max-width: 100%;
	}
	/* Long values (paths, IDs, commands) scroll sideways instead of being cut off. */
	.scroll {
		overflow-x: auto;
		overflow-y: hidden;
		text-overflow: clip;
		white-space: nowrap;
		scrollbar-width: thin;
		user-select: text;
	}
	.scroll:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
		border-radius: 3px;
	}
	.hc-cmd code.scroll {
		padding-bottom: 2px;
	}
	h3.hc-sec__label {
		margin-top: 0;
	}
	.sec-note {
		text-transform: none;
		letter-spacing: 0;
		font-weight: 450;
	}
	.msg-text {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		display: block;
		max-height: 14em;
		overflow: auto;
	}
	.quiet {
		margin: 0;
		font: 400 12.5px/19px var(--font-sans);
		color: var(--ink-muted);
	}
	.cmd {
		margin-top: 8px;
	}
	.field-error {
		margin: 6px 2px 0;
		font: 450 12px/16px var(--font-sans);
		color: var(--status-error);
	}
	.hc-sec__label label {
		cursor: default;
	}
	.footnote {
		margin: 8px 2px 0;
		font: 450 11px/14px var(--font-sans);
		color: var(--ink-subtle);
	}
</style>
