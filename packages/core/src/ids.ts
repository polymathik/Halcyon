import { PROVIDERS, type ProviderId, type SessionId } from './session.js';

// Native IDs are passed to a provider CLI as an argument when resuming, so
// they stay strict: UUIDs where the provider uses them, otherwise a short
// token of letters, digits, "_" and "-" that can never start with "-" (and so
// can never be read as a flag).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const OPENCODE = /^ses_[0-9A-Za-z]{20,40}$/;

const NATIVE_ID: Record<ProviderId, RegExp> = {
	claude: UUID,
	codex: UUID,
	cursor: UUID,
	gemini: TOKEN,
	qwen: UUID,
	copilot: UUID,
	opencode: OPENCODE,
	kilo: OPENCODE,
	crush: TOKEN,
	goose: TOKEN
};

/** Providers whose IDs are case-insensitive UUIDs, normalized to lower case. */
const CASE_INSENSITIVE = new Set<ProviderId>(['claude', 'codex', 'cursor', 'qwen', 'copilot']);

export function isProviderId(value: unknown): value is ProviderId {
	return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

/** Whether `value` is a valid native ID for `provider` (a UUID when no provider is given). */
export function isValidNativeId(value: unknown, provider?: ProviderId): value is string {
	return typeof value === 'string' && (provider ? NATIVE_ID[provider] : UUID).test(value);
}

export function toSessionId(provider: ProviderId, nativeId: string): SessionId {
	if (!isValidNativeId(nativeId, provider)) {
		throw new Error(`Invalid ${provider} session ID`);
	}
	return `${provider}:${CASE_INSENSITIVE.has(provider) ? nativeId.toLowerCase() : nativeId}`;
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
	if (!isProviderId(provider) || !isValidNativeId(nativeId, provider)) return null;
	const id = toSessionId(provider, nativeId);
	return { provider, nativeId: id.slice(provider.length + 1), id };
}
