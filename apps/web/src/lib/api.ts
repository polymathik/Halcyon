import type { SessionsResponse, WorkspaceResponse } from '@halcyon/core';

async function getJson<T>(path: string, fetcher: typeof fetch = fetch): Promise<T> {
	const response = await fetcher(path, { headers: { accept: 'application/json' } });
	if (!response.ok) {
		throw new Error(`Request to ${path} failed with status ${response.status}`);
	}
	return (await response.json()) as T;
}

export const api = {
	sessions: (fetcher?: typeof fetch) => getJson<SessionsResponse>('/api/sessions', fetcher),
	workspace: (fetcher?: typeof fetch) => getJson<WorkspaceResponse>('/api/workspace', fetcher)
};
