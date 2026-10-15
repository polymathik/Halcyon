import type { ProviderAdapter } from '@halcyon/core';
import { createOpenCodeFamilyAdapter, type OpenCodeFamilyConfig, type OpenCodeFamilyOptions } from './opencode-family.js';

export const OPENCODE_CONFIG: OpenCodeFamilyConfig = {
	provider: 'opencode',
	displayName: 'OpenCode',
	executable: 'opencode',
	appDir: 'opencode',
	dbFile: 'opencode.db',
	dbEnv: 'OPENCODE_DB'
};

export type OpenCodeAdapterOptions = OpenCodeFamilyOptions;

/**
 * OpenCode sessions from `$OPENCODE_DB` or
 * `${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db` (1.2+), or the
 * pre-1.2 JSON files under `<data>/storage` when no database exists.
 * Resumes with `opencode <directory> --session <id>`.
 */
export function createOpenCodeAdapter(options: OpenCodeAdapterOptions = {}): ProviderAdapter {
	return createOpenCodeFamilyAdapter(OPENCODE_CONFIG, options);
}
