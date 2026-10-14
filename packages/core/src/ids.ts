import { PROVIDERS, type ProviderId, type SessionId } from './session.js';

// Both providers currently use UUIDs. Keep the native ID strict: it is passed
// to a provider CLI as an argument when resuming.
const NATIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isProviderId(value: unknown): value is ProviderId {
	return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

export function isValidNativeId(value: unknown): value is string {
	return typeof value === 'string' && NATIVE_ID.test(value);
}

export function toSessionId(provider: ProviderId, nativeId: string): SessionId {
	if (!isValidNativeId(nativeId)) {
		throw new Error(`Invalid ${provider} session ID`);
	}
	return `${provider}:${nativeId.toLowerCase()}`;
}

/** Parses a provider-scoped ID, returning `null` for anything malformed. */
export function parseSessionId(
	value: unknown
): { provider: ProviderId; nativeId: string; id: SessionId } | null {
	if (typeof value !== 'string') return null;
	const separator = value.indexOf(':');
	if (separator < 0) return null;
	const provider = value.slice(0, separator);
	const nativeId = value.slice(separator + 1);
	if (!isProviderId(provider) || !isValidNativeId(nativeId)) return null;
	return { provider, nativeId: nativeId.toLowerCase(), id: toSessionId(provider, nativeId) };
}
