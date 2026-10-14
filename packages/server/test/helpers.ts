import { migrate } from '../src/db/migrations.js';
import { openDatabase } from '../src/db/sqlite.js';

export function memoryDb() {
	const db = openDatabase(':memory:');
	migrate(db);
	return db;
}

export const ids = {
	a: '0b3c5c8e-6f1a-4d2b-9c3e-1a2b3c4d5e6f',
	b: '1c4d6d9f-7a2b-4e3c-8d4f-2b3c4d5e6f70',
	c: '2d5e7e0a-8b3c-4f4d-9e5a-3c4d5e6f7081'
};
