import type { PreviewMessage, PreviewOptions } from '@halcyon/core';

/** Preview reads start this far from the end of a plain transcript. */
export const PREVIEW_TAIL_BYTES = 2 * 1024 * 1024;

/**
 * Collects the most recent preview messages while a transcript streams past.
 * Consecutive assistant text within one turn is collapsed to the latest text
 * (the reply the user saw last), so tool-heavy turns take one slot.
 */
export class PreviewCollector {
	private items: PreviewMessage[] = [];

	constructor(private readonly options: Pick<PreviewOptions, 'limit' | 'maxChars'>) {}

	add(role: PreviewMessage['role'], rawText: string, at: string | null): void {
		const text = rawText.trim();
		if (text === '') return;
		const { maxChars } = this.options;
		const clipped = text.length > maxChars;
		const message: PreviewMessage = {
			role,
			text: clipped ? `${text.slice(0, maxChars).trimEnd()}…` : text,
			clipped,
			at
		};
		const last = this.items.at(-1);
		if (role === 'assistant' && last?.role === 'assistant') {
			this.items[this.items.length - 1] = message;
			return;
		}
		this.items.push(message);
		// Keep a small margin so a later merge cannot drop below the limit.
		if (this.items.length > this.options.limit * 2) this.items.splice(0, this.items.length - this.options.limit);
	}

	get count(): number {
		return this.items.length;
	}

	messages(): PreviewMessage[] {
		return this.items.slice(-this.options.limit);
	}
}

const ELEMENT = /<([A-Za-z][\w:-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g;

/**
 * True when text consists only of XML-like wrapper elements, which CLIs use for
 * injected context and slash-command bookkeeping rather than typed prompts.
 * Structural check only; the text itself is not interpreted.
 */
export function isWrapperOnly(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.startsWith('<') && trimmed.replace(ELEMENT, '').trim() === '';
}

export function normalizeTime(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Ensures a cached source path is inside the adapter's own store. */
export function assertInside(root: string, path: string): void {
	const prefix = root.endsWith('/') || root.endsWith('\\') ? root : `${root}${root.includes('\\') ? '\\' : '/'}`;
	if (!path.startsWith(prefix)) throw new Error('Transcript is outside the provider store');
}
