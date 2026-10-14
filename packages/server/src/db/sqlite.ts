import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

export type Database = DatabaseSyncType;

/**
 * Loads `node:sqlite` without printing its ExperimentalWarning. The module is
 * stable enough for a local cache and avoids a native dependency at install.
 */
function loadSqlite(): typeof import('node:sqlite') {
	const originalEmit = process.emitWarning;
	process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
		const message = typeof warning === 'string' ? warning : warning.message;
		if (message.includes('SQLite')) return;
		return (originalEmit as (...args: unknown[]) => void).call(process, warning, ...rest);
	}) as typeof process.emitWarning;
	try {
		return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
	} finally {
		process.emitWarning = originalEmit;
	}
}

export function openDatabase(path: string): Database {
	const { DatabaseSync } = loadSqlite();
	const db = new DatabaseSync(path);
	db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;');
	return db;
}
