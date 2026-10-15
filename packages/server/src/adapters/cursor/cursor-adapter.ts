import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
	DiscoveredSession,
	NativeCommand,
	PreviewMessage,
	PreviewOptions,
	ProviderAdapter,
	ProviderAvailability,
	ScanContext,
	ScanResult,
	ScanWarning,
	Session,
	SourceFingerprint
} from '@halcyon/core';
import { isValidNativeId, toSessionId } from '@halcyon/core';
import { assertInside } from '../preview.js';
import { parseMetaJson, readStoreMeta, type CursorChatMeta } from './store-meta.js';
import { countCursorUserTurns, previewCursorTranscript } from './transcript.js';

const PARSER_VERSION = 1;
const BUCKET = /^[0-9a-f]{32}$/;
const MAX_META_BYTES = 64 * 1024;

export interface CursorAdapterOptions {
	/**
	 * Cursor CLI config directory (holds `chats/`); defaults to
	 * `$CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`, else `~/.cursor`.
	 */
	root?: string;
	/**
	 * Cursor data directory (holds `projects/<slug>/agent-transcripts/`);
	 * defaults to `root` when `root` is given, else `$CURSOR_DATA_DIR` or `~/.cursor`.
	 */
	dataRoot?: string;
}

export function cursorConfigRoot(options: CursorAdapterOptions = {}): string {
	if (options.root) return options.root;
	if (process.env.CURSOR_CONFIG_DIR) return process.env.CURSOR_CONFIG_DIR;
	if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, 'cursor');
	return join(homedir(), '.cursor');
}

export function cursorDataRoot(options: CursorAdapterOptions = {}): string {
	if (options.dataRoot) return options.dataRoot;
	if (options.root) return options.root;
	return process.env.CURSOR_DATA_DIR || join(homedir(), '.cursor');
}

/** Cursor's project slug for a working directory (used for transcript folders). */
export function cursorProjectSlug(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

export const cursorBucket = (cwd: string): string => createHash('md5').update(resolve(cwd)).digest('hex');

/**
 * Discovers Cursor CLI (`cursor-agent`) chats from
 * `<config>/chats/<md5(cwd)>/<chat uuid>/{meta.json,store.db}`, listed the way
 * `cursor-agent ls` lists them: chats without `store.db`, subagent chats and
 * chats without a conversation are skipped. Transcript blobs in `store.db`
 * are never read; only `meta.json` (or the store's `meta` row when that file
 * is missing) and, for the turn count and preview, the plain agent transcript
 * under `<data>/projects/<slug>/agent-transcripts/`.
 */
export function createCursorAdapter(options: CursorAdapterOptions = {}): ProviderAdapter {
	const configRoot = cursorConfigRoot(options);
	const dataRoot = cursorDataRoot(options);
	const chatsDir = join(configRoot, 'chats');
	const projectsDir = join(dataRoot, 'projects');

	return {
		provider: 'cursor',
		displayName: 'Cursor CLI',
		parserVersion: PARSER_VERSION,

		async detect(): Promise<ProviderAvailability> {
			try {
				const info = await stat(chatsDir);
				if (!info.isDirectory()) return { available: false, reason: `${chatsDir} is not a directory` };
				await access(chatsDir, constants.R_OK | constants.X_OK);
				return { available: true, storePath: chatsDir };
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== 'ENOENT') return { available: false, reason: `Cannot read ${chatsDir} (${code ?? 'error'})` };
			}
			// No chats yet: available (empty) only when Cursor's own folder exists.
			try {
				if ((await stat(configRoot)).isDirectory()) return { available: true, storePath: chatsDir };
			} catch {
				// fall through
			}
			return { available: false, reason: `No Cursor CLI sessions found at ${chatsDir}` };
		},

		async scan(context: ScanContext): Promise<ScanResult> {
			const warnings = new WarningCounter();
			const sessions: DiscoveredSession[] = [];
			let parsedCount = 0;

			for (const chat of await listChats(chatsDir, warnings)) {
				context.signal?.throwIfAborted();

				let dbInfo;
				try {
					dbInfo = await stat(join(chat.dir, 'store.db'));
					if (!dbInfo.isFile()) continue;
				} catch {
					continue; // `cursor-agent ls` skips chats without a store
				}
				if (!isValidNativeId(chat.nativeId, 'cursor')) {
					warnings.add('unsupported-schema');
					continue;
				}

				const metaPath = join(chat.dir, 'meta.json');
				const metaFile = await readSmallFile(metaPath);
				let meta: CursorChatMeta | null = metaFile ? parseMetaJson(metaFile.text) : null;
				if (!meta) {
					try {
						meta = readStoreMeta(join(chat.dir, 'store.db'));
					} catch {
						warnings.add('unreadable-file');
						continue;
					}
					if (!meta) {
						warnings.add('unsupported-schema');
						continue;
					}
				}
				if (meta.isSubagent || !meta.hasConversation) continue;

				const cwd = meta.cwd;
				if (cwd !== null && cursorBucket(cwd) !== chat.bucket) warnings.add('index-mismatch');

				const transcript = cwd !== null ? await findTranscript(projectsDir, cwd, chat.nativeId) : null;
				const mtimes = [dbInfo.mtimeMs, metaFile?.mtimeMs ?? 0, transcript?.mtimeMs ?? 0];
				const source: SourceFingerprint = {
					path: transcript?.path ?? join(chat.dir, 'store.db'),
					sizeBytes: (transcript?.size ?? 0) + (metaFile?.size ?? 0) + dbInfo.size,
					mtimeMs: Math.max(...mtimes)
				};

				const cached = context.cache.get(source.path);
				if (
					cached &&
					cached.parserVersion === PARSER_VERSION &&
					cached.source.sizeBytes === source.sizeBytes &&
					cached.source.mtimeMs === source.mtimeMs &&
					cached.session.provider === 'cursor'
				) {
					sessions.push({ session: cached.session, source: cached.source });
					continue;
				}

				let userTurnCount: number | null = null;
				if (transcript) {
					try {
						const counted = await countCursorUserTurns(transcript.path, context.signal);
						userTurnCount = counted.userTurnCount;
						if (counted.stats.malformedLines > 0) warnings.add('malformed-records', counted.stats.malformedLines);
						parsedCount++;
					} catch (error) {
						if (context.signal?.aborted) throw error;
						warnings.add('unreadable-file');
					}
				}

				const updatedMs = meta.updatedAtMs;
				const session: Session = {
					id: toSessionId('cursor', chat.nativeId),
					provider: 'cursor',
					nativeId: chat.nativeId.toLowerCase(),
					title: meta.title,
					titleSource: meta.title !== null ? 'provider-generated' : null,
					projectPath: cwd,
					latestPath: null,
					startedAt: isoOrNull(meta.createdAtMs),
					lastActivityAt: new Date(updatedMs ?? dbInfo.mtimeMs).toISOString(),
					lastActivitySource: updatedMs !== null ? 'provider-index' : 'file-mtime',
					userTurnCount
				};
				sessions.push({ session, source });
			}

			return { sessions, warnings: warnings.list(), parsedCount };
		},

		resumeCommand(session: Session): NativeCommand | null {
			if (!isValidNativeId(session.nativeId, 'cursor')) return null;
			// `cursor-agent` resolves chats by the current directory, so it must run there.
			if (!session.projectPath) return null;
			return { executable: 'cursor-agent', args: ['--resume', session.nativeId], cwd: session.projectPath };
		},

		async preview(sourcePath: string, options: PreviewOptions): Promise<PreviewMessage[]> {
			if (sourcePath.endsWith('.db')) {
				assertInside(chatsDir, sourcePath);
				return []; // no plain transcript; store blobs are not parsed
			}
			assertInside(projectsDir, sourcePath);
			if (!sourcePath.endsWith('.jsonl')) throw new Error('Transcript is outside the provider store');
			return previewCursorTranscript(sourcePath, options);
		}
	};
}

interface ChatDir {
	dir: string;
	bucket: string;
	nativeId: string;
}

async function listChats(chatsDir: string, warnings: WarningCounter): Promise<ChatDir[]> {
	let buckets;
	try {
		buckets = await readdir(chatsDir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw new Error(`Cannot read Cursor CLI chats directory (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
	}
	const chats: ChatDir[] = [];
	for (const bucket of buckets) {
		if (!bucket.isDirectory() || !BUCKET.test(bucket.name)) continue;
		const bucketDir = join(chatsDir, bucket.name);
		let entries;
		try {
			entries = await readdir(bucketDir, { withFileTypes: true });
		} catch {
			warnings.add('unreadable-file');
			continue;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) chats.push({ dir: join(bucketDir, entry.name), bucket: bucket.name, nativeId: entry.name });
		}
	}
	return chats;
}

async function readSmallFile(path: string): Promise<{ text: string; size: number; mtimeMs: number } | null> {
	let handle;
	try {
		handle = await open(path, 'r');
		const info = await handle.stat();
		if (!info.isFile() || info.size > MAX_META_BYTES) return null;
		return { text: await handle.readFile('utf8'), size: info.size, mtimeMs: info.mtimeMs };
	} catch {
		return null;
	} finally {
		await handle?.close();
	}
}

/** `<projects>/<slug>/agent-transcripts/<id>/<id>.jsonl`, or the older flat `<id>.jsonl`. */
async function findTranscript(
	projectsDir: string,
	cwd: string,
	nativeId: string
): Promise<{ path: string; size: number; mtimeMs: number } | null> {
	const slug = cursorProjectSlug(cwd);
	if (slug === '') return null;
	const dir = join(projectsDir, slug, 'agent-transcripts');
	for (const path of [join(dir, nativeId, `${nativeId}.jsonl`), join(dir, `${nativeId}.jsonl`)]) {
		try {
			const info = await stat(path);
			if (info.isFile()) return { path, size: info.size, mtimeMs: info.mtimeMs };
		} catch {
			// try the next layout
		}
	}
	return null;
}

const isoOrNull = (ms: number | null): string | null => {
	if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const WARNING_TEXT: Record<ScanWarning['code'], string> = {
	'malformed-records': 'Malformed transcript lines were skipped',
	'unreadable-file': 'Some Cursor CLI chats or folders could not be read',
	'unsupported-schema': 'Some Cursor CLI chats use an unrecognized format or ID',
	'index-mismatch': 'Some Cursor CLI chats record a folder that does not match their project bucket'
};

class WarningCounter {
	private counts = new Map<ScanWarning['code'], number>();

	add(code: ScanWarning['code'], count = 1): void {
		this.counts.set(code, (this.counts.get(code) ?? 0) + count);
	}

	list(): ScanWarning[] {
		return [...this.counts].map(([code, count]) => ({ code, message: WARNING_TEXT[code], count }));
	}
}
