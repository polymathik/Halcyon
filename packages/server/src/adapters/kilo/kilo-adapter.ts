import type { ProviderAdapter } from '@halcyon/core';
import {
	createOpenCodeFamilyAdapter,
	type OpenCodeFamilyConfig,
	type OpenCodeFamilyOptions
} from '../opencode/opencode-family.js';

export const KILO_CONFIG: OpenCodeFamilyConfig = {
	provider: 'kilo',
	displayName: 'Kilo Code',
	executable: 'kilo',
	appDir: 'kilo',
	dbFile: 'kilo.db',
	dbEnv: 'KILO_DB'
};

export type KiloAdapterOptions = OpenCodeFamilyOptions;

/**
 * Kilo Code CLI is an OpenCode fork with the same storage schema. Sessions come
 * from `$KILO_DB` or `${XDG_DATA_HOME:-~/.local/share}/kilo/kilo.db`.
 * Resumes with `kilo <directory> --session <id>`.
 */
export function createKiloAdapter(options: KiloAdapterOptions = {}): ProviderAdapter {
	return createOpenCodeFamilyAdapter(KILO_CONFIG, options);
}
