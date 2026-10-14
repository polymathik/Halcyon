import { describe, expect, it } from 'vitest';
import { parseSessionId, toSessionId } from '@halcyon/core';

const UUID = '0b3c5c8e-6f1a-4d2b-9c3e-1a2b3c4d5e6f';

describe('session IDs', () => {
	it('round-trips a provider-scoped ID and normalizes case', () => {
		const id = toSessionId('claude', UUID.toUpperCase());
		expect(id).toBe(`claude:${UUID}`);
		expect(parseSessionId(id)).toEqual({ provider: 'claude', nativeId: UUID, id });
	});

	it.each([
		['unknown provider', `gemini:${UUID}`],
		['missing provider', UUID],
		['shell metacharacters', `codex:${UUID}; rm -rf ~`],
		['option injection', 'codex:--help'],
		['path traversal', 'claude:../../etc/passwd'],
		['non-string', 42]
	])('rejects %s', (_, value) => {
		expect(parseSessionId(value)).toBeNull();
	});

	it('refuses to build an ID from an invalid native ID', () => {
		expect(() => toSessionId('codex', 'not-a-uuid')).toThrow();
	});
});
