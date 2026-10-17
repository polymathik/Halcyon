import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createFixtureAdapter, fixtureSession } from '../src/adapters/fixture-adapter.js';
import { SessionCacheStore } from '../src/db/session-cache.js';
import { DiscoveryService } from '../src/discovery/discovery-service.js';
import {
	FileGitReader,
	parseHead,
	parseRemotes,
	readRepository,
	sanitizeRemoteUrl,
	webUrlFor
} from '../src/discovery/git-info.js';
import { ids, memoryDb } from './helpers.js';

// Invented repositories built from plain files; no git process is used.
const base = mkdtempSync(join(tmpdir(), 'halcyon-git-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let counter = 0;
function repo(files: Record<string, string>, name = `repo-${counter++}`): string {
	const root = join(base, name);
	for (const [rel, content] of Object.entries(files)) {
		const path = join(root, rel);
		mkdirSync(join(path, '..'), { recursive: true });
		writeFileSync(path, content);
	}
	return root;
}
const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('git info: reading a repository', () => {
	it('reads branch and origin, removing credentials from the URL', async () => {
		const root = repo({
			'.git/HEAD': 'ref: refs/heads/feature/login\n',
			'.git/config': [
				'[core]',
				'\tbare = false',
				'[remote "upstream"]',
				'\turl = git@github.com:someone/else.git',
				'[remote "origin"]',
				'\turl = https://user:ghp_invented_token@github.com/acme/widgets.git?x=1',
				'\tfetch = +refs/heads/*:refs/remotes/origin/*'
			].join('\n')
		});
		expect(await readRepository(root)).toEqual({
			root,
			name: 'widgets',
			remoteUrl: 'https://github.com/acme/widgets.git',
			webUrl: 'https://github.com/acme/widgets',
			branch: 'feature/login',
			detached: false
		});
	});

	it('follows a linked worktree to the shared config', async () => {
		const main = repo({
			'.git/HEAD': 'ref: refs/heads/main\n',
			'.git/config': '[remote "origin"]\n\turl = git@gitlab.example.com:team/app.git\n',
			'.git/worktrees/wt/HEAD': 'ref: refs/heads/hotfix\n',
			'.git/worktrees/wt/commondir': '../..\n'
		});
		const wt = repo({ '.git': `gitdir: ${join(main, '.git/worktrees/wt')}\n` });
		expect(await readRepository(wt)).toMatchObject({
			root: wt,
			name: 'app',
			remoteUrl: 'git@gitlab.example.com:team/app.git',
			webUrl: 'https://gitlab.example.com/team/app',
			branch: 'hotfix'
		});
	});

	it('reports a detached HEAD as a short hash, and names a repo without remotes after its folder', async () => {
		const root = repo({ '.git/HEAD': `${SHA}\n` }, 'no-remote');
		expect(await readRepository(root)).toEqual({
			root,
			name: 'no-remote',
			remoteUrl: null,
			webUrl: null,
			branch: '0123456',
			detached: true
		});
	});

	it('tolerates an unreadable HEAD, a malformed config and a missing .git', async () => {
		const broken = repo({ '.git/HEAD': 'garbage', '.git/config': '[remote "origin"\nurl\n\u0000' }, 'broken');
		expect(await readRepository(broken)).toMatchObject({ name: 'broken', branch: null, remoteUrl: null });
		expect(await readRepository(repo({ 'README': 'x' }))).toBeNull();
		expect(await readRepository(repo({ '.git': 'not a gitdir line' }))).toBeNull();
	});

	it('finds the repository from a subfolder and re-reads after the cache expires', async () => {
		const root = repo({ '.git/HEAD': 'ref: refs/heads/main\n', 'src/app/x': '' });
		const reader = new FileGitReader(undefined, 0);
		expect((await reader.read(join(root, 'src/app')))?.branch).toBe('main');
		writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/next\n');
		expect((await reader.read(join(root, 'src/app')))?.branch).toBe('next');
		expect(await reader.read(join(base, 'not-a-repo'))).toBeNull();
	});
});

describe('git info: parsing helpers', () => {
	it('parses HEAD', () => {
		expect(parseHead('ref: refs/heads/main')).toEqual({ branch: 'main', detached: false });
		expect(parseHead(SHA.toUpperCase())).toEqual({ branch: '0123456', detached: true });
		expect(parseHead('nonsense')).toBeNull();
	});

	it('parses remotes and ignores other sections', () => {
		const config = '[branch "main"]\n\turl = nope\n[remote "a b"]\n  URL = "https://x.example/r"\n; comment\n';
		expect(parseRemotes(config)).toEqual([{ name: 'a b', url: 'https://x.example/r' }]);
	});

	it('removes secrets from remote URLs', () => {
		expect(sanitizeRemoteUrl('https://oauth2:tok@gitlab.example.com/g/p.git#frag')).toBe('https://gitlab.example.com/g/p.git');
		expect(sanitizeRemoteUrl('ssh://git:pw@host.example:2222/p.git')).toBe('ssh://git@host.example:2222/p.git');
		expect(sanitizeRemoteUrl('me:secret@host.example:o/r.git')).toBe('me@host.example:o/r.git');
		expect(sanitizeRemoteUrl('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
		expect(sanitizeRemoteUrl('/srv/git/app.git')).toBe('/srv/git/app.git');
		expect(sanitizeRemoteUrl('https://x\n.example')).toBeNull();
		expect(sanitizeRemoteUrl('')).toBeNull();
	});

	it('derives web links only for plausible hosts', () => {
		expect(webUrlFor('ssh://git@github.com/o/r.git')).toBe('https://github.com/o/r');
		expect(webUrlFor('https://git.example.com:8443/o/r.git')).toBe('https://git.example.com:8443/o/r');
		expect(webUrlFor('git@localhost:o/r.git')).toBeNull();
		expect(webUrlFor('/srv/git/app.git')).toBeNull();
		expect(webUrlFor('file:///srv/git/app.git')).toBeNull();
	});
});

describe('git info: discovery', () => {
	it('adds git details per folder, uses the repo root as project root, and survives a failing reader', async () => {
		const sessions = [
			fixtureSession('claude', ids.a, { projectPath: '/work/app/web' }),
			fixtureSession('claude', ids.b, { projectPath: '/work/other' }),
			fixtureSession('claude', ids.c, { projectPath: '/work/boom' })
		];
		const reads: string[] = [];
		const git = {
			async read(path: string) {
				reads.push(path);
				if (path === '/work/boom') throw new Error('unreadable');
				return path === '/work/app/web'
					? { root: '/work/app', name: 'app', remoteUrl: null, webUrl: null, branch: 'main', detached: false }
					: null;
			}
		};
		const discovery = new DiscoveryService([createFixtureAdapter('claude', sessions)], new SessionCacheStore(memoryDb()), { git });
		const { sessions: found } = await discovery.refresh();
		const byId = new Map(found.map((s) => [s.nativeId, s]));
		expect(byId.get(ids.a)).toMatchObject({ projectRoot: '/work/app', git: { name: 'app', branch: 'main' } });
		expect(byId.get(ids.b)).toMatchObject({ projectRoot: '/work/other', git: null });
		expect(byId.get(ids.c)).toMatchObject({ git: null });
		expect(reads.sort()).toEqual(['/work/app/web', '/work/boom', '/work/other']);
	});
});
