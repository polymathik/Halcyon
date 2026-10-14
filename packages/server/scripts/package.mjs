// Builds a self-contained, installable package in packages/server/release/:
// one bundled dist/cli.js (server, adapters and @halcyon/core; no runtime
// dependencies) plus the built web UI in dist/web, then runs `npm pack`.
// Run after `pnpm build` (the web build must exist).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const pkg = JSON.parse(readFileSync(here('../package.json'), 'utf8'));
const out = here('../release/');
const web = here('../../../apps/web/build/');

if (!existsSync(web)) {
	console.error('apps/web/build is missing; run `pnpm build` first.');
	process.exit(1);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(here('../release/dist'), { recursive: true });

await build({
	entryPoints: [here('../src/cli.ts')],
	outfile: here('../release/dist/cli.js'),
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node22',
	sourcemap: false,
	legalComments: 'inline',
	alias: { '@halcyon/core': here('../../core/src/index.ts') },
	// The source starts with a shebang; keep exactly one.
	banner: { js: '' }
});
cpSync(web, here('../release/dist/web'), { recursive: true });

writeFileSync(
	here('../release/package.json'),
	JSON.stringify(
		{
			name: pkg.name,
			version: pkg.version,
			description: pkg.description,
			type: 'module',
			bin: { halcyon: './dist/cli.js' },
			files: ['dist'],
			engines: pkg.engines,
			license: pkg.license ?? 'UNLICENSED'
		},
		null,
		2
	) + '\n'
);
writeFileSync(
	here('../release/README.md'),
	`# Halcyon\n\nA calm, spatial canvas for your local Claude Code and Codex CLI sessions.\n\n\`\`\`\nhalcyon            # start on 127.0.0.1:4317 and open your browser\nhalcyon --help\n\`\`\`\n\nEverything stays on this machine: the server binds to 127.0.0.1, sends no telemetry and needs no account.\n`
);
const tarball = execFileSync('npm', ['pack', '--silent'], { cwd: out, encoding: 'utf8' }).trim();
console.log(`Packed release/${tarball}`);
