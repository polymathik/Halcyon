import type { ProviderAdapter } from '@halcyon/core';
import { createClaudeAdapter } from './claude/claude-adapter.js';
import { createCodexAdapter } from './codex/codex-adapter.js';
import { createCopilotAdapter } from './copilot/copilot-adapter.js';
import { createCrushAdapter } from './crush/crush-adapter.js';
import { createCursorAdapter } from './cursor/cursor-adapter.js';
import { createGeminiAdapter } from './gemini/gemini-adapter.js';
import { createGooseAdapter } from './goose/goose-adapter.js';
import { createKiloAdapter } from './kilo/kilo-adapter.js';
import { createOpenCodeAdapter } from './opencode/opencode-adapter.js';
import { createQwenAdapter } from './qwen/qwen-adapter.js';

/**
 * Real provider adapters, in display order. Each one fails independently;
 * a CLI that isn't installed simply reports itself unavailable.
 */
export function defaultAdapters(): ProviderAdapter[] {
	return [
		createClaudeAdapter(),
		createCodexAdapter(),
		createCursorAdapter(),
		createGeminiAdapter(),
		createQwenAdapter(),
		createCopilotAdapter(),
		createOpenCodeAdapter(),
		createKiloAdapter(),
		createCrushAdapter(),
		createGooseAdapter()
	];
}
