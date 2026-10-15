import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import type { PreviewMessage, PreviewOptions, ScanWarning } from '@halcyon/core';
import { isWrapperOnly, PreviewCollector } from './preview.js';
import type { Database } from '../db/sqlite.js';

/**
 * Small helpers shared by the SQLite-backed adapters (OpenCode, Kilo, Crush,
 * Goose). Kept here, beside the first SQLite adapter, until a shared module
 * for SQLite provider stores exists.
 */

/** Source path used for a session stored in a SQLite database. */
export function sqliteSourcePath(dbPath: string, nativeId: string): string {
	return `${dbPath}#${nativeId}`;
}

/**
 * Splits `<db>#<id>` and checks the database is one the adapter owns. Throws
 * for anything else, so a preview can never open an arbitrary file.
 */
export function parseSqliteSourcePath(
	sourcePath: string,
	isOwnDb: (dbPath: string) => boolean
): { dbPath: string; nativeId: string } {
	const separator = sourcePath.lastIndexOf('#');
	if (separator <= 0) throw new Error('Transcript is outside the provider store');
	const dbPath = sourcePath.slice(0, separator);
	const nativeId = sourcePath.slice(separator + 1);
	if (!isOwnDb(dbPath)) throw new Error('Transcript is outside the provider store');
	return { dbPath, nativeId };
}

export type FileState = 'file' | 'missing' | 'unreadable' | 'not-file';

export async function fileState(path: string): Promise<FileState> {
	try {
		const info = await stat(path);
		if (!info.isFile()) return 'not-file';
		await access(path, constants.R_OK);
		return 'file';
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unreadable';
	}
}

export async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/** Names of a table's columns, or null when the table does not exist. */
export function tableColumns(db: Database, table: string): Set<string> | null {
	const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
	if (!exists) return null;
	// Table names here are constants from the adapters, never user input.
	const rows = db.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all() as { name: unknown }[];
	return new Set(rows.map((row) => String(row.name)));
}

export function hasColumns(columns: Set<string> | null, required: readonly string[]): columns is Set<string> {
	return columns !== null && required.every((name) => columns.has(name));
}

/** Epoch milliseconds to ISO 8601. */
export function msToIso(value: unknown): string | null {
	const ms = typeof value === 'bigint' ? Number(value) : value;
	if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Epoch seconds (or milliseconds, when the value is clearly that large) to ISO 8601. */
export function epochToIso(value: unknown): string | null {
	const n = typeof value === 'bigint' ? Number(value) : value;
	if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
	return msToIso(n > 10_000_000_000 ? n : n * 1000);
}

const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

/**
 * A SQLite timestamp in any of the shapes providers write: an epoch number,
 * `CURRENT_TIMESTAMP` / `datetime('now')` text (UTC without a zone), or
 * RFC 3339 text with a zone.
 */
export function sqliteTimeToIso(value: unknown): string | null {
	if (typeof value === 'number' || typeof value === 'bigint') return epochToIso(value);
	if (typeof value !== 'string') return null;
	const text = value.trim();
	if (text === '') return null;
	if (/^\d+(?:\.\d+)?$/.test(text)) return epochToIso(Number(text));
	const normalized = NAIVE_DATETIME.test(text) ? `${text.replace(' ', 'T')}Z` : text.replace(' ', 'T');
	const ms = Date.parse(normalized);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function asString(value: unknown): string | null {
	return typeof value === 'string' && value !== '' ? value : null;
}

export function asCount(value: unknown): number {
	if (typeof value === 'bigint') return Number(value);
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** SQLite booleans arrive as 0/1, but older rows can hold text. */
export function asBool(value: unknown): boolean {
	if (typeof value === 'number' || typeof value === 'bigint') return Number(value) !== 0;
	if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true';
	return value === true;
}

/** Accumulates warnings by code and message key, without quoting content. */
export class WarningCounter {
	private readonly entries = new Map<string, ScanWarning>();

	add(code: ScanWarning['code'], message: string, count = 1): void {
		if (count <= 0) return;
		const key = `${code}\u0000${message}`;
		const existing = this.entries.get(key);
		if (existing) existing.count += count;
		else this.entries.set(key, { code, message, count });
	}

	list(): ScanWarning[] {
		return [...this.entries.values()];
	}
}

const INJECTED_BLOCK = /<(system-reminder|environment_context|user_instructions)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Removes injected wrapper blocks so a preview shows only typed prompt text. */
export function stripInjected(text: string): string {
	return text.replace(INJECTED_BLOCK, '').trim();
}

export interface PreviewRow {
	/** Message key; consecutive rows with the same key are one message. */
	key: string;
	role: 'user' | 'assistant';
	at: string | null;
	text: unknown;
}

/**
 * Turns chronologically ordered text rows (one per text part) into preview
 * messages. User text loses injected wrappers; wrapper-only prompts are dropped.
 */
export function collectPreview(rows: PreviewRow[], options: Pick<PreviewOptions, 'limit' | 'maxChars'>): PreviewMessage[] {
	const collector = new PreviewCollector(options);
	let index = 0;
	while (index < rows.length) {
		const first = rows[index]!;
		const texts: string[] = [];
		while (index < rows.length && rows[index]!.key === first.key) {
			const text = rows[index]!.text;
			if (typeof text === 'string') texts.push(text);
			index++;
		}
		const joined = texts.join('\n\n');
		if (first.role === 'user') {
			const clean = stripInjected(joined);
			if (clean !== '' && !isWrapperOnly(clean)) collector.add('user', clean, first.at);
		} else {
			collector.add('assistant', joined, first.at);
		}
	}
	return collector.messages();
}
