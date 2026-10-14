/**
 * Light/dark theme. With no stored choice the OS preference applies (tokens.css
 * handles that with a media query). An explicit choice is stored per browser and
 * written to <html data-theme>. Storage can throw or be empty; the UI still works.
 */
export type Theme = 'light' | 'dark';

const KEY = 'halcyon.theme';

function stored(): Theme | null {
	try {
		const value = localStorage.getItem(KEY);
		return value === 'light' || value === 'dark' ? value : null;
	} catch {
		return null;
	}
}

export function systemTheme(): Theme {
	return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** The theme currently in effect. */
export function currentTheme(): Theme {
	return stored() ?? systemTheme();
}

/** Apply any stored choice before first render. */
export function applyStoredTheme(): void {
	const theme = stored();
	if (theme) document.documentElement.dataset.theme = theme;
}

export function setTheme(theme: Theme): void {
	document.documentElement.dataset.theme = theme;
	try {
		localStorage.setItem(KEY, theme);
	} catch {
		// Not persisted; the choice still applies for this page.
	}
}
