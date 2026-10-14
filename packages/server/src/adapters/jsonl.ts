import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { createZstdDecompress } from 'node:zlib';

export interface JsonlStats {
	/** Complete lines that were not valid JSON objects. */
	malformedLines: number;
	/**
	 * True when the file ends with an unterminated line that does not parse,
	 * which is normal while a provider is still writing.
	 */
	partialTail: boolean;
	/** Bytes read from disk (compressed size when decompressing). */
	bytesRead: number;
}

export interface JsonlOptions {
	signal?: AbortSignal;
	/**
	 * Cheap pre-filter on the raw line. Return false to skip JSON parsing for
	 * records the caller does not need; large transcripts are mostly tool output.
	 */
	accept?: (line: string) => boolean;
	/** Decode a compressed file (Codex compresses finished rollouts with zstd). */
	decompress?: 'zstd';
}

/**
 * Streams a JSONL file, calling `onRecord` for each parsed object. Never throws
 * on malformed content; it counts it instead. Callers must not log `line` or
 * record values: transcripts can contain secrets.
 */
export async function readJsonl(
	path: string,
	onRecord: (record: Record<string, unknown>) => void,
	options: JsonlOptions = {}
): Promise<JsonlStats> {
	const stats: JsonlStats = { malformedLines: 0, partialTail: false, bytesRead: 0 };
	const decoder = new StringDecoder('utf8');
	let remainder = '';

	const handle = (line: string, complete: boolean) => {
		if (line.trim() === '') return;
		if (options.accept && !options.accept(line)) return;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			if (complete) stats.malformedLines++;
			else stats.partialTail = true;
			return;
		}
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			onRecord(value as Record<string, unknown>);
		} else if (complete) {
			stats.malformedLines++;
		}
	};

	const source = createReadStream(path, options.signal ? { signal: options.signal } : {});
	const compressed = options.decompress === 'zstd';
	let chunks: AsyncIterable<Buffer> = source;
	if (compressed) {
		// Count bytes on disk; the iterator below sees decompressed output.
		source.on('data', (chunk: string | Buffer) => {
			stats.bytesRead += chunk.length;
		});
		const decompressed = source.pipe(createZstdDecompress());
		source.on('error', (error) => decompressed.destroy(error));
		chunks = decompressed;
	}
	try {
		for await (const chunk of chunks) {
			if (!compressed) stats.bytesRead += chunk.length;
			const text = remainder + decoder.write(chunk);
			let start = 0;
			let newline = text.indexOf('\n', start);
			while (newline >= 0) {
				handle(text.slice(start, newline), true);
				start = newline + 1;
				newline = text.indexOf('\n', start);
			}
			remainder = text.slice(start);
		}
	} finally {
		source.destroy();
	}
	handle(remainder + decoder.end(), false);
	return stats;
}
