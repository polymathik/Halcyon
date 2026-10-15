#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { parseArgs } from 'node:util';
import type { ProviderAdapter } from '@halcyon/core';
import { demoFixtureAdapters } from './adapters/fixture-adapter.js';
import { defaultAdapters } from './adapters/index.js';
import { NativeActions } from './actions/native.js';
import { startServer, type RunningServer } from './server.js';

const DEFAULT_PORT = 4317;
const PORT_ATTEMPTS = 10;

const HELP = `Usage: halcyon [options]

Starts the Halcyon dashboard on localhost and opens it in your browser.

Options:
  -p, --port <n>     Port to listen on (default ${DEFAULT_PORT}; tries the next few if busy)
      --no-open      Do not open a browser
      --fixtures     Show synthetic demo sessions instead of real ones
      --data-dir <d> Where Halcyon stores its database (default ~/.halcyon or $HALCYON_HOME)
  -h, --help         Show this help
`;

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			port: { type: 'string', short: 'p' },
			open: { type: 'boolean', default: true },
			'no-open': { type: 'boolean' },
			fixtures: { type: 'boolean', default: false },
			'data-dir': { type: 'string' },
			help: { type: 'boolean', short: 'h' }
		},
		allowNegative: true
	});
	if (values.help) {
		process.stdout.write(HELP);
		return;
	}

	const requestedPort = values.port === undefined ? undefined : Number(values.port);
	if (requestedPort !== undefined && (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535)) {
		throw new Error(`Invalid port: ${values.port}`);
	}
	const adapters: ProviderAdapter[] = values.fixtures ? demoFixtureAdapters() : defaultAdapters();
	const server = await listenWithFallback(requestedPort, adapters, values['data-dir'], values.fixtures);

	process.stdout.write(`Halcyon is running at ${server.url}\nPress Ctrl+C to stop.\n`);
	if (values.open && !values['no-open']) openBrowser(server.url);

	const shutdown = () => {
		void server.close().then(() => process.exit(0));
	};
	process.once('SIGINT', shutdown);
	process.once('SIGTERM', shutdown);
}

const demoLauncher = {
	async launch() {
		throw new Error('demo');
	},
	async available() {
		return true;
	}
};

async function listenWithFallback(
	requestedPort: number | undefined,
	adapters: ProviderAdapter[],
	dataDir: string | undefined,
	demo = false
): Promise<RunningServer> {
	// An explicit port is honored exactly; the default walks forward if busy.
	const ports =
		requestedPort === undefined
			? Array.from({ length: PORT_ATTEMPTS }, (_, i) => DEFAULT_PORT + i)
			: [requestedPort];
	let lastError: unknown;
	for (const port of ports) {
		try {
			return await startServer({
				port,
				adapters,
				...(dataDir ? { dataDir } : {}),
				// Demo sessions have invented folders and IDs: their actions never start a process.
				...(demo ? { actions: new NativeActions(demoLauncher) } : {})
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
			lastError = error;
		}
	}
	throw lastError;
}

function openBrowser(url: string): void {
	const [command, args] =
		process.platform === 'darwin'
			? ['open', [url]]
			: process.platform === 'win32'
				? ['cmd', ['/c', 'start', '""', url]]
				: ['xdg-open', [url]];
	execFile(command, args, (error) => {
		if (error) process.stdout.write(`Open ${url} in your browser.\n`);
	});
}

main().catch((error: unknown) => {
	process.stderr.write(`halcyon: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
