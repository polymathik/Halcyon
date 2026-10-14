import { createHash } from 'node:crypto';

/**
 * Content-Security-Policy for the UI. The SvelteKit SPA shell boots from an
 * inline script, so each inline script is allowed by its SHA-256 hash rather
 * than by `'unsafe-inline'`. Everything else must come from this origin.
 */
export function contentSecurityPolicy(shellHtml: string): string {
	const hashes = [...shellHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
		(match) => `'sha256-${createHash('sha256').update(match[1] ?? '', 'utf8').digest('base64')}'`
	);
	return [
		"default-src 'self'",
		`script-src 'self' ${hashes.join(' ')}`.trim(),
		// Svelte sets inline style attributes (card positions, camera transform).
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data:",
		"font-src 'self' data:",
		"connect-src 'self'",
		"object-src 'none'",
		"base-uri 'none'",
		"frame-ancestors 'none'",
		"form-action 'none'"
	].join('; ');
}
