/**
 * Per-browser view preferences. Storage can be missing or throw (private
 * windows, blocked site data); every read falls back to the default.
 */
export function readPref(key: string, fallback: boolean): boolean {
	try {
		const value = localStorage.getItem(`halcyon.${key}`);
		return value === null ? fallback : value === '1';
	} catch {
		return fallback;
	}
}

export function writePref(key: string, value: boolean): void {
	try {
		localStorage.setItem(`halcyon.${key}`, value ? '1' : '0');
	} catch {
		// Applies for this page only.
	}
}
