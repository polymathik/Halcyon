// Copies the built SvelteKit app into dist/web so the published CLI is self-contained.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../../../apps/web/build/', import.meta.url));
const target = fileURLToPath(new URL('../dist/web/', import.meta.url));

if (!existsSync(source)) {
	console.error('apps/web/build is missing; run the web build first.');
	process.exit(1);
}
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log('Copied web build to dist/web');
