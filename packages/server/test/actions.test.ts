import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { NativeCommand, ProviderAdapter } from '@halcyon/core';
import { displayCommand, NativeActions, shellQuote, type Launcher } from '../src/actions/native.js';
import { createFixtureAdapter, fixtureSession } from '../src/adapters/fixture-adapter.js';
import { SessionCacheStore } from '../src/db/session-cache.js';
import { WorkspaceStore } from '../src/db/workspace-store.js';
import { DiscoveryService } from '../src/discovery/discovery-service.js';
import { contentSecurityPolicy } from '../src/http/csp.js';
import { createApp } from '../src/http/app.js';
import { ids, memoryDb } from './helpers.js';

const dir = mkdtempSync(join(tmpdir(), "halcyon actions 'q'-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

class FakeLauncher implements Launcher {
	calls: { executable: string; args: string[]; cwd?: string }[] = [];
	constructor(private readonly onPath: string[] = []) {}
	async launch(executable: string, args: string[], options: { cwd?: string } = {}) {
		this.calls.push({ executable, args, ...(options.cwd ? { cwd: options.cwd } : {}) });
	}
	async available(executable: string) {
		return this.onPath.includes(executable);
	}
}

const command = (cwd: string | null): NativeCommand => ({ executable: 'claude', args: ['--resume', ids.a], cwd });

describe('command rendering', () => {
	it('quotes every token for a POSIX shell', () => {
		expect(shellQuote("it's here")).toBe(`'it'\\''s here'`);
		expect(shellQuote('/plain/path')).toBe('/plain/path');
		expect(displayCommand(command('/Users/me/my project'), 'darwin')).toBe(`cd '/Users/me/my project' && claude --resume ${ids.a}`);
		expect(displayCommand(command(null), 'linux')).toBe(`claude --resume ${ids.a}`);
		expect(displayCommand(command('C:\\Users\\me\\a b'), 'win32')).toBe(`cd "C:\\Users\\me\\a b" && claude --resume ${ids.a}`);
	});
});

describe('native actions', () => {
	it('resumes on macOS through Terminal, passing the command as an argument', async () => {
		const launcher = new FakeLauncher();
		const result = await new NativeActions(launcher, 'darwin').resume(command(dir));
		expect(result).toEqual({ ok: true });
		const call = launcher.calls[0]!;
		expect(call.executable).toBe('osascript');
		expect(call.args.at(-1)).toBe(displayCommand(command(dir), 'darwin'));
		// The script itself never contains the command or the folder.
		expect(call.args.slice(0, -1).join(' ')).not.toContain(dir);
	});

	it('uses the first Linux terminal on PATH and keeps the window open', async () => {
		const launcher = new FakeLauncher(['xterm']);
		expect(await new NativeActions(launcher, 'linux').resume(command(dir))).toEqual({ ok: true });
		expect(launcher.calls[0]).toMatchObject({ executable: 'xterm', cwd: dir });
		expect(launcher.calls[0]!.args.slice(0, 3)).toEqual(['-e', 'sh', '-c']);
	});

	it('explains why resume or open is unavailable', async () => {
		const launcher = new FakeLauncher();
		expect((await new NativeActions(launcher, 'linux').resume(command(dir))).ok).toBe(false);
		expect((await new NativeActions(launcher, 'darwin').resume(command(join(dir, 'gone')))).ok).toBe(false);
		expect((await new NativeActions(launcher, 'win32').resume(command(dir))).ok).toBe(false);
		expect((await new NativeActions(launcher, 'darwin').openFolder(join(dir, 'gone'))).ok).toBe(false);
		expect(launcher.calls).toEqual([]);
		expect(await new NativeActions(launcher, 'darwin').openFolder(dir)).toEqual({ ok: true });
		expect(launcher.calls[0]).toEqual({ executable: 'open', args: [dir] });
	});
});

describe('action endpoints', () => {
	const HOST = '127.0.0.1:4317';
	function setup() {
		const db = memoryDb();
		const base = createFixtureAdapter('claude', [fixtureSession('claude', ids.a, { projectPath: dir })]);
		const adapter: ProviderAdapter = {
			...base,
			resumeCommand: (session) => ({ executable: 'claude', args: ['--resume', session.nativeId], cwd: session.projectPath })
		};
		const launcher = new FakeLauncher();
		const app = createApp({
			discovery: new DiscoveryService([adapter], new SessionCacheStore(db)),
			workspaces: new WorkspaceStore(db),
			allowedHosts: [HOST],
			webRoot: null,
			actions: new NativeActions(launcher, 'darwin')
		});
		const call = (method: string, path: string, origin = `http://${HOST}`) =>
			app.request(path, { method, headers: { host: HOST, origin } });
		return { call, launcher };
	}

	it('describes, resumes and opens a session', async () => {
		const { call, launcher } = setup();
		const info = await (await call('GET', `/api/sessions/claude:${ids.a}/command`)).json();
		expect(info).toMatchObject({ canResume: true, canOpenFolder: true });
		expect(info.command).toContain(`claude --resume ${ids.a}`);
		expect((await call('POST', `/api/sessions/claude:${ids.a}/resume`)).status).toBe(204);
		expect((await call('POST', `/api/sessions/claude:${ids.a}/open-folder`)).status).toBe(204);
		expect(launcher.calls.map((c) => c.executable)).toEqual(['osascript', 'open']);
	});

	it('refuses cross-origin and unknown sessions without launching anything', async () => {
		const { call, launcher } = setup();
		expect((await call('POST', `/api/sessions/claude:${ids.a}/resume`, 'https://evil.example')).status).toBe(403);
		expect((await call('POST', `/api/sessions/claude:${ids.b}/resume`)).status).toBe(404);
		expect((await call('POST', '/api/sessions/claude:..%2F..%2Fetc/resume')).status).toBe(400);
		expect(launcher.calls).toEqual([]);
	});
});

describe('content security policy', () => {
	it('allows inline scripts only by hash', () => {
		const csp = contentSecurityPolicy('<script>boot()</script><script src="/a.js"></script>');
		expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+';/);
		expect(csp).not.toContain('unsafe-inline\'; script');
		expect(csp.match(/sha256-/g)).toHaveLength(1);
		expect(csp).toContain("frame-ancestors 'none'");
	});
});
