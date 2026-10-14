import type { ProviderAdapter } from '@halcyon/core';
import { createClaudeAdapter } from './claude/claude-adapter.js';
import { createCodexAdapter } from './codex/codex-adapter.js';

/** Real provider adapters, in display order. */
export function defaultAdapters(): ProviderAdapter[] {
	return [createClaudeAdapter(), createCodexAdapter()];
}
