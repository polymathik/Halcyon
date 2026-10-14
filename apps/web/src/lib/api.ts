import type {
	LiveResponse,
	PlacementBatch,
	SavedFilter,
	SessionCommandResponse,
	SessionPreviewResponse,
	SessionsResponse,
	TagsResponse,
	Viewport,
	WorkspaceResponse,
	Zone,
	ZoneInput
} from '@halcyon/core';

async function errorMessage(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { error?: unknown };
		if (typeof body.error === 'string') return body.error;
	} catch {
		// Fall through to the status.
	}
	return `Request failed with status ${response.status}`;
}

async function getJson<T>(path: string, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<T> {
	const response = await fetcher(path, { headers: { accept: 'application/json' }, ...(signal ? { signal } : {}) });
	if (!response.ok) throw new Error(await errorMessage(response));
	return (await response.json()) as T;
}

/** Same-origin writes carry an Origin header, which the server requires. */
async function send<T = void>(method: string, path: string, body?: unknown): Promise<T> {
	const response = await fetch(path, {
		method,
		headers: body === undefined ? {} : { 'content-type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) })
	});
	if (!response.ok) throw new Error(await errorMessage(response));
	return (response.status === 204 ? undefined : await response.json()) as T;
}

const sessionPath = (id: string, rest: string) => `/api/sessions/${encodeURIComponent(id)}/${rest}`;

export const api = {
	sessions: (fetcher?: typeof fetch) => getJson<SessionsResponse>('/api/sessions', fetcher),
	live: (signal?: AbortSignal) => getJson<LiveResponse>('/api/live', fetch, signal),
	workspace: (fetcher?: typeof fetch) => getJson<WorkspaceResponse>('/api/workspace', fetcher),
	preview: (sessionId: string, signal?: AbortSignal) => getJson<SessionPreviewResponse>(sessionPath(sessionId, 'preview'), fetch, signal),
	command: (sessionId: string, signal?: AbortSignal) => getJson<SessionCommandResponse>(sessionPath(sessionId, 'command'), fetch, signal),
	resume: (sessionId: string) => send('POST', sessionPath(sessionId, 'resume')),
	openFolder: (sessionId: string) => send('POST', sessionPath(sessionId, 'open-folder')),
	setArchived: (sessionIds: string[], archived: boolean) => send('PUT', '/api/sessions/archive', { sessionIds, archived }),
	setTitle: (sessionId: string, title: string | null) => send('PUT', sessionPath(sessionId, 'title'), { title }),
	setTags: (sessionId: string, tags: string[]) => send<TagsResponse>('PUT', sessionPath(sessionId, 'tags'), { tags }),
	savePlacements: (placements: PlacementBatch['placements']) => send('PUT', '/api/workspace/placements', { placements }),
	saveViewport: (viewport: Viewport) => send('PUT', '/api/workspace/viewport', viewport),
	saveFilter: (filter: SavedFilter | null) => send('PUT', '/api/workspace/filter', filter),
	createZone: (zone: ZoneInput) => send<Zone>('POST', '/api/workspace/zones', zone),
	updateZone: (id: number, changes: Partial<ZoneInput>) => send<Zone>('PATCH', `/api/workspace/zones/${id}`, changes),
	deleteZone: (id: number) => send('DELETE', `/api/workspace/zones/${id}`)
};
