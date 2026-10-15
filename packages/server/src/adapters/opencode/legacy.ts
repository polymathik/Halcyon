import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { PreviewMessage, PreviewOptions } from '@halcyon/core';
import { isWrapperOnly, PreviewCollector } from '../preview.js';
import { msToIso, stripInjected } from '../sqlite-store.js';

/**
 * OpenCode before 1.2 kept sessions as JSON files under `<data>/storage`:
 *   session/<projectID>/<sessionID>.json
 *   message/<sessionID>/<messageID>.json
 *   part/<messageID>/<partID>.json
 * Message and part IDs sort chronologically (ascending identifiers).
 */

export interface LegacySessionFile {
	path: string;
	projectId: string;
}

export interface LegacySessionFacts {
	id: string;
	parentId: string | null;
	directory: string | null;
	title: string | null;
	created: number | null;
	updated: number | null;
	archived: boolean;
}

const JSON_FILE = /^[^.].*\.json$/;

export async function listLegacySessionFiles(
	storageDir: string,
	signal?: AbortSignal
): Promise<{ files: LegacySessionFile[]; unreadableDirs: number }> {
	const files: LegacySessionFile[] = [];
	let unreadableDirs = 0;
	const sessionDir = join(storageDir, 'session');
	let projects: Dirent[];
	try {
		projects = await readdir(sessionDir, { withFileTypes: true });
	} catch {
		return { files, unreadableDirs: 1 };
	}
	for (const project of projects) {
		signal?.throwIfAborted();
		if (!project.isDirectory()) continue;
		let entries: Dirent[];
		try {
			entries = await readdir(join(sessionDir, project.name), { withFileTypes: true });
		} catch {
			unreadableDirs++;
			continue;
		}
		for (const entry of entries) {
			if (entry.isFile() && JSON_FILE.test(entry.name)) {
				files.push({ path: join(sessionDir, project.name, entry.name), projectId: project.name });
			}
		}
	}
	return { files, unreadableDirs };
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
	try {
		const value: unknown = JSON.parse(await readFile(path, 'utf8'));
		return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** Reads only the metadata fields of a legacy session file; null when malformed. */
export async function readLegacySession(path: string): Promise<LegacySessionFacts | null> {
	const record = await readJson(path);
	if (!record) return null;
	const id = str(record.id);
	if (!id) return null;
	const time = record.time && typeof record.time === 'object' ? (record.time as Record<string, unknown>) : {};
	return {
		id,
		parentId: str(record.parentID),
		directory: str(record.directory),
		title: str(record.title),
		created: num(time.created),
		updated: num(time.updated),
		archived: num(time.archived) !== null
	};
}

export async function readLegacyWorktree(storageDir: string, projectId: string): Promise<string | null> {
	if (!/^[A-Za-z0-9_-]+$/.test(projectId)) return null;
	const record = await readJson(join(storageDir, 'project', `${projectId}.json`));
	return record ? str(record.worktree) : null;
}

async function sortedJsonFiles(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && JSON_FILE.test(entry.name))
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

interface TextPart {
	text: string;
}

async function textParts(storageDir: string, messageId: string): Promise<TextPart[] | null> {
	if (!/^[A-Za-z0-9_-]+$/.test(messageId)) return null;
	const dir = join(storageDir, 'part', messageId);
	const parts: TextPart[] = [];
	for (const name of await sortedJsonFiles(dir)) {
		const part = await readJson(join(dir, name));
		if (!part || part.type !== 'text' || part.synthetic === true || part.ignored === true) continue;
		if (typeof part.text === 'string') parts.push({ text: part.text });
	}
	return parts;
}

/** The newest modification time of the session file and its message folder. */
export async function legacyFingerprint(
	storageDir: string,
	sessionPath: string,
	sessionId: string
): Promise<{ sizeBytes: number; mtimeMs: number }> {
	const info = await stat(sessionPath);
	let mtimeMs = info.mtimeMs;
	try {
		mtimeMs = Math.max(mtimeMs, (await stat(join(storageDir, 'message', sessionId))).mtimeMs);
	} catch {
		// No messages yet.
	}
	return { sizeBytes: info.size, mtimeMs };
}

/** Human user messages: role `user` with at least one non-synthetic text part. */
export async function countLegacyUserTurns(
	storageDir: string,
	sessionId: string,
	signal?: AbortSignal
): Promise<{ count: number; malformed: number }> {
	const dir = join(storageDir, 'message', sessionId);
	let count = 0;
	let malformed = 0;
	for (const name of await sortedJsonFiles(dir)) {
		signal?.throwIfAborted();
		const message = await readJson(join(dir, name));
		if (!message) {
			malformed++;
			continue;
		}
		if (message.role !== 'user' || typeof message.id !== 'string') continue;
		const parts = await textParts(storageDir, message.id);
		if (parts && parts.some((part) => part.text.trim() !== '')) count++;
	}
	return { count, malformed };
}

/** Bounded preview of a legacy session: the last few message files only. */
export async function previewLegacySession(
	storageDir: string,
	sessionPath: string,
	options: PreviewOptions
): Promise<PreviewMessage[]> {
	const sessionId = basename(sessionPath, '.json');
	if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return [];
	const dir = join(storageDir, 'message', sessionId);
	const names = (await sortedJsonFiles(dir)).slice(-Math.max(1, options.limit) * 8);
	const collector = new PreviewCollector(options);
	for (const name of names) {
		options.signal?.throwIfAborted();
		const message = await readJson(join(dir, name));
		if (!message || typeof message.id !== 'string') continue;
		const role = message.role;
		if (role !== 'user' && role !== 'assistant') continue;
		const parts = await textParts(storageDir, message.id);
		if (!parts || parts.length === 0) continue;
		const text = parts.map((part) => part.text).join('\n\n');
		const clean = role === 'user' ? stripInjected(text) : text;
		if (role === 'user' && (clean === '' || isWrapperOnly(clean))) continue;
		const time = message.time && typeof message.time === 'object' ? (message.time as Record<string, unknown>) : {};
		collector.add(role, clean, msToIso(time.created));
	}
	return collector.messages();
}
