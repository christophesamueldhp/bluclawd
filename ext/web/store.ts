/**
 * Session-local store of fetched pages and search results, addressed by short
 * ids (`f1`, `s2`). `get_search_content` pages through and searches it,
 * `source_check` checks claims against it, and `/web` browses it.
 *
 * In memory only: an entry is the model's working material for this session,
 * not a cache worth its own file permissions and eviction on disk. Bounded like
 * pi-web-access's store (1 hour, 128 entries, 128MB of text).
 */

export interface StoredContent {
	id: string;
	kind: "fetch" | "search";
	/** The URL fetched, or the query searched. */
	source: string;
	text: string;
	createdAt: number;
}

const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 128;
const MAX_CHARS = 128 * 1024 * 1024;

const entries = new Map<string, StoredContent>();
let counter = 0;

function prune(now: number): void {
	let chars = 0;
	for (const entry of entries.values()) chars += entry.text.length;
	for (const [id, entry] of entries) {
		const expired = now - entry.createdAt >= TTL_MS;
		if (!expired && entries.size <= MAX_ENTRIES && chars <= MAX_CHARS) break;
		entries.delete(id);
		chars -= entry.text.length;
	}
}

export function putContent(kind: StoredContent["kind"], source: string, text: string, now = Date.now()): string {
	const id = `${kind === "fetch" ? "f" : "s"}${++counter}`;
	entries.set(id, { id, kind, source, text, createdAt: now });
	prune(now);
	return id;
}

export function getContent(id: string, now = Date.now()): StoredContent | undefined {
	const entry = entries.get(id);
	if (entry && now - entry.createdAt >= TTL_MS) {
		entries.delete(id);
		return undefined;
	}
	return entry;
}

/** Newest first. */
export function listContent(now = Date.now()): StoredContent[] {
	prune(now);
	return [...entries.values()].reverse();
}

export function clearContent(): void {
	entries.clear();
	counter = 0;
}

/** Lines `offset`..`offset+limit-1` (1-based), with a pointer to the next slice. */
export function sliceLines(text: string, offset = 1, limit = 200): string {
	const lines = text.split("\n");
	const start = Math.max(1, Math.floor(offset));
	const end = Math.min(lines.length, start + Math.max(1, Math.floor(limit)) - 1);
	if (start > lines.length) return `[offset ${start} is past the end: ${lines.length} lines]`;
	const body = lines.slice(start - 1, end).join("\n");
	return end < lines.length
		? `${body}\n\n[lines ${start}-${end} of ${lines.length}; continue with offset=${end + 1}]`
		: `${body}\n\n[lines ${start}-${end} of ${lines.length}]`;
}

/**
 * Every line containing any needle (case-insensitive), with `context` lines
 * around it, merged where they overlap and prefixed with line numbers.
 */
export function findLines(text: string, needles: string[], context = 2, maxMatches = 50): string {
	const wanted = needles.map((n) => n.toLowerCase()).filter(Boolean);
	if (wanted.length === 0) return "[no search text given]";
	const lines = text.split("\n");
	const hits: number[] = [];
	for (let i = 0; i < lines.length && hits.length < maxMatches; i++) {
		const line = lines[i].toLowerCase();
		if (wanted.some((n) => line.includes(n))) hits.push(i);
	}
	if (hits.length === 0) return `[no line contains ${needles.map((n) => JSON.stringify(n)).join(" or ")}]`;
	const blocks: string[] = [];
	let from = -1;
	let to = -1;
	const flush = () => {
		if (from < 0) return;
		blocks.push(
			lines
				.slice(from, to + 1)
				.map((l, k) => `${from + k + 1}: ${l}`)
				.join("\n"),
		);
	};
	for (const hit of hits) {
		const a = Math.max(0, hit - context);
		const b = Math.min(lines.length - 1, hit + context);
		if (from >= 0 && a <= to + 1) {
			to = Math.max(to, b);
		} else {
			flush();
			from = a;
			to = b;
		}
	}
	flush();
	const capped = hits.length >= maxMatches ? `\n\n[stopped at ${maxMatches} matching lines]` : "";
	return blocks.join("\n...\n") + capped;
}
