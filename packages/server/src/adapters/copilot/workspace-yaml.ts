/**
 * A deliberately small reader for Copilot CLI's `workspace.yaml`, a flat map
 * of snake_case scalars. Only top-level `key: value` lines are read; nested
 * structures, block scalars, anchors and anything unrecognized are ignored.
 */
export type YamlScalar = string | boolean | number | null;

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_]*)\s*:(?:\s+(.*))?$/;
const MAX_YAML_BYTES = 256 * 1024;

export function parseFlatYaml(raw: string): Map<string, YamlScalar> {
	const values = new Map<string, YamlScalar>();
	if (raw.length > MAX_YAML_BYTES) return values;
	for (const line of raw.split(/\r?\n/)) {
		if (line === '' || /^\s/.test(line) || line.startsWith('#') || line.startsWith('-')) continue;
		const match = KEY_LINE.exec(line);
		if (!match) continue;
		const key = match[1]!;
		const value = parseScalar((match[2] ?? '').trim());
		if (value !== undefined) values.set(key, value);
	}
	return values;
}

/** Returns undefined for values that are not plain scalars (nested, block, alias). */
function parseScalar(text: string): YamlScalar | undefined {
	if (text === '' || text === '~' || text === 'null') return text === '' ? undefined : null;
	if (text.startsWith('"')) {
		const end = closingDoubleQuote(text);
		if (end < 0) return undefined;
		try {
			return JSON.parse(text.slice(0, end + 1)) as string;
		} catch {
			return undefined;
		}
	}
	if (text.startsWith("'")) {
		let out = '';
		for (let i = 1; i < text.length; i++) {
			const ch = text[i]!;
			if (ch === "'") {
				if (text[i + 1] === "'") {
					out += "'";
					i++;
					continue;
				}
				return out;
			}
			out += ch;
		}
		return undefined;
	}
	if (/^[|>&*!{[]/.test(text)) return undefined;
	const plain = text.replace(/\s+#.*$/, '').trim();
	if (plain === 'true') return true;
	if (plain === 'false') return false;
	if (/^-?\d+(\.\d+)?$/.test(plain)) return Number(plain);
	return plain;
}

function closingDoubleQuote(text: string): number {
	for (let i = 1; i < text.length; i++) {
		if (text[i] === '\\') i++;
		else if (text[i] === '"') return i;
	}
	return -1;
}

export interface CopilotWorkspace {
	id: string | null;
	cwd: string | null;
	name: string | null;
	userNamed: boolean;
	summary: string | null;
	createdAt: string | null;
	updatedAt: string | null;
}

const str = (value: YamlScalar | undefined): string | null => {
	if (typeof value === 'number') return String(value);
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
};

const iso = (value: YamlScalar | undefined): string | null => {
	const text = str(value);
	if (!text) return null;
	const ms = Date.parse(text);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

export function parseWorkspaceYaml(raw: string): CopilotWorkspace {
	const values = parseFlatYaml(raw);
	return {
		id: str(values.get('id')),
		cwd: str(values.get('cwd')),
		name: str(values.get('name')),
		userNamed: values.get('user_named') === true,
		summary: str(values.get('summary')),
		createdAt: iso(values.get('created_at')),
		updatedAt: iso(values.get('updated_at'))
	};
}
