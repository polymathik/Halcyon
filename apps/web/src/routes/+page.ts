import { api } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	try {
		return { sessions: await api.sessions(fetch), error: null };
	} catch (error) {
		return { sessions: null, error: error instanceof Error ? error.message : 'Could not reach Halcyon' };
	}
};
