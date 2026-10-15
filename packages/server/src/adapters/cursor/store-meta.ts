import { openReadOnlyDatabase } from '../../db/sqlite.js';

/**
 * The fields Halcyon uses from a Cursor CLI chat, from `meta.json` or, when
 * that is missing or invalid, from the chat's `store.db` `meta` table.
 */
export interface CursorChatMeta {
	createdAtMs: number | null;
	updatedAtMs: number | null;
	hasConversation: boolean;
	isSubagent: boolean;
	title: string | null;
	cwd: string | null;
}

const MAX_META_BYTES = 64 * 1024;
/** Cursor's placeholder name for an unnamed agent; not a real title. */
const DEFAULT_NAME = 'New Agent';

const text = (value: unknown): string | null =>
	typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** Normalizes a timestamp recorded in seconds, milliseconds, micro- or nanoseconds to ms. */
export function normalizeEpochMs(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
	if (value < 1e11) return value * 1000;
	if (value >= 1e17) return value / 1e6;
	if (value >= 1e14) return value / 1000;
	return value;
}

/** Parses `meta.json`; returns null when it is not a valid Cursor chat record. */
export function parseMetaJson(raw: string): CursorChatMeta | null {
	if (raw.length > MAX_META_BYTES) return null;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.createdAtMs !== 'number' || !Number.isFinite(record.createdAtMs)) return null;
	const updated = record.updatedAtMs;
	const title = text(record.title);
	return {
		createdAtMs: record.createdAtMs,
		updatedAtMs: typeof updated === 'number' && Number.isFinite(updated) && updated > 0 ? updated : null,
		hasConversation: record.hasConversation === true,
		isSubagent: record.isSubagent === true,
		title: title === DEFAULT_NAME ? null : title,
		cwd: text(record.cwd)
	};
}

/**
 * Reads the chat's metadata row from `store.db` (`meta` table, key `'0'`, a
 * hex-encoded JSON object). The row also holds the chat's blob encryption key:
 * it is deleted as soon as the row is parsed and never copied anywhere.
 * Throws a content-free error when the database cannot be read.
 */
export function readStoreMeta(dbPath: string): CursorChatMeta | null {
	let db;
	let encoded: unknown;
	try {
		db = openReadOnlyDatabase(dbPath);
		const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value?: unknown } | undefined;
		encoded = row?.value;
	} catch {
		throw new Error('Cursor chat store is not readable');
	} finally {
		db?.close();
	}

	const hex =
		typeof encoded === 'string' ? encoded : encoded instanceof Uint8Array ? Buffer.from(encoded).toString('utf8') : null;
	encoded = undefined;
	if (!hex || hex.length % 2 !== 0 || hex.length > MAX_META_BYTES * 2 || !/^[0-9a-fA-F]+$/.test(hex)) return null;

	let record: Record<string, unknown>;
	try {
		const value: unknown = JSON.parse(Buffer.from(hex, 'hex').toString('utf8'));
		if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
		record = value as Record<string, unknown>;
	} catch {
		return null;
	}
	// Secret: drop it before anything else touches the record.
	delete record.blobEncryptionKey;

	const name = text(record.name);
	return {
		createdAtMs: normalizeEpochMs(record.createdAt),
		updatedAtMs: null,
		hasConversation: text(record.latestRootBlobId) !== null,
		isSubagent: record.subagentInfo !== undefined && record.subagentInfo !== null,
		title: name === DEFAULT_NAME ? null : name,
		cwd: null
	};
}
