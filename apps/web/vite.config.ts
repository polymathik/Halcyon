import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Dev only: forward API calls to a running `halcyon --no-open` server.
const apiTarget = process.env.HALCYON_API ?? 'http://127.0.0.1:4317';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// Single-page app: the local server serves 200.html for any non-API path.
			adapter: adapter({ fallback: '200.html' })
		})
	],
	server: {
		proxy: {
			'/api': {
				target: apiTarget,
				// The server only accepts its own Host and Origin.
				changeOrigin: true,
				headers: { origin: apiTarget }
			}
		}
	}
});
