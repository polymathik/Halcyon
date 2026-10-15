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
		['unknown provider', `aider:${UUID}`],
		['missing provider', UUID],
		['shell metacharacters', `codex:${UUID}; rm -rf ~`],
		['option injection', 'codex:--help'],
		['path traversal', 'claude:../../etc/passwd'],
		['non-string', 42]
	])('rejects %s', (_, value) => {
		expect(parseSessionId(value)).toBeNull();
	});

	it('applies each provider\'s own ID rule and keeps case where IDs are case-sensitive', () => {
		expect(parseSessionId('opencode:ses_0a1b2c3d4e5fAbCdEfGhIjKlMn')?.nativeId).toBe('ses_0a1b2c3d4e5fAbCdEfGhIjKlMn');
		expect(parseSessionId('goose:20261015_3')?.id).toBe('goose:20261015_3');
		expect(parseSessionId('gemini:my-session_1')).not.toBeNull();
		for (const bad of ['opencode:not_ses', 'goose:-rf', 'gemini:../x', 'crush:a b', 'goose:' + 'a'.repeat(200), 'cursor:not-a-uuid']) {
			expect(parseSessionId(bad), bad).toBeNull();
		}
	});

	it('refuses to build an ID from an invalid native ID', () => {
		expect(() => toSessionId('codex', 'not-a-uuid')).toThrow();
	});
});
