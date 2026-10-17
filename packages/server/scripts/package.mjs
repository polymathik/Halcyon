// Builds a self-contained, installable package in packages/server/release/:
// one bundled dist/halcyon.js (server, adapters and @halcyon/core; no runtime
// dependencies) behind a small dist/cli.js Node version guard, plus the built
// web UI in dist/web, then runs `npm pack`. Publish from release/, not from
// packages/server/ (that package is private and uses workspace dependencies).
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
	outfile: here('../release/dist/halcyon.js'),
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

// npx and npm only warn about `engines`, and the bundle's static `node:sqlite`
// import fails before any of its code runs on an older Node. Check first, then
// load the bundle dynamically.
const minNode = pkg.engines.node.replace(/^>=\s*/, '');
writeFileSync(
	here('../release/dist/cli.js'),
	[
		'#!/usr/bin/env node',
		`const required = ${JSON.stringify(minNode)};`,
		"const [major, minor] = process.versions.node.split('.').map(Number);",
		"const [reqMajor, reqMinor] = required.split('.').map(Number);",
		'if (major < reqMajor || (major === reqMajor && minor < reqMinor)) {',
		'\tprocess.stderr.write(`halcyon: Node.js ${required} or newer is required (found ${process.versions.node}).\\n`);',
		'\tprocess.exit(1);',
		'}',
		"await import('./halcyon.js');",
		''
	].join('\n'),
	{ mode: 0o755 }
);
cpSync(web, here('../release/dist/web'), { recursive: true });

writeFileSync(
	here('../release/package.json'),
	JSON.stringify(
		{
			name: pkg.name,
			version: pkg.version,
			description: pkg.description,
			type: 'module',
			bin: { halcyon: 'dist/cli.js' },
			files: ['dist', 'NOTICE', 'THIRD_PARTY_NOTICES.md'],
			engines: pkg.engines,
			license: pkg.license,
			author: pkg.author,
			homepage: pkg.homepage,
			// Keep `directory` so npm links to packages/server inside the monorepo.
			repository: pkg.repository,
			bugs: pkg.bugs,
			keywords: pkg.keywords
		},
		null,
		2
	) + '\n'
);
// Licence, notices and a short README travel with the package.
for (const file of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
	cpSync(here(`../../../${file}`), here(`../release/${file}`));
}
writeFileSync(
	here('../release/README.md'),
	[
		'# Halcyon',
		'',
		'One calm canvas for every AI coding session on your machine: Claude Code, Codex CLI, Cursor CLI, Gemini CLI, Qwen Code, GitHub Copilot CLI, OpenCode, Kilo Code, Crush and Goose.',
		'',
		'```',
		`npx ${pkg.name}            # start on 127.0.0.1:4317 and open your browser`,
		`npx ${pkg.name} --fixtures # try it with invented demo sessions`,
		'```',
		'',
		'Or install the `halcyon` command globally:',
		'',
		'```',
		`npm install -g ${pkg.name}`,
		'halcyon',
		'halcyon --help',
		'```',
		'',
		`Requires Node.js ${pkg.engines.node.replace(/^>=\s*/, '')} or newer (Halcyon uses the built-in \`node:sqlite\`).`,
		'',
		'Everything stays on this machine: the server binds to 127.0.0.1, sends no telemetry and needs no account.',
		'',
		`Documentation: ${pkg.homepage}. Licensed under the Apache License 2.0.`,
		''
	].join('\n')
);
const tarball = execFileSync('npm', ['pack', '--silent'], { cwd: out, encoding: 'utf8' }).trim();
console.log(`Packed release/${tarball}`);
