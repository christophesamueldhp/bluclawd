/**
 * Markdown from the React Server Components flight payload a Next.js App Router
 * page embeds as `<script>self.__next_f.push([1,"..."])</script>`. Client-rendered
 * docs sites often ship an HTML shell whose real text only exists in that payload.
 *
 * Ported from pi-web-access's rsc-extract.ts (MIT, Nico Bailon).
 *
 * Constraints seen on real pages: Next splits rows across pushes, so pushes are
 * concatenated before rows are parsed; `T` text rows have no newline terminator
 * and are sized in UTF-8 bytes; a row is usually inlined by a parent row, so the
 * tree is walked from unreferenced rows in id order with one visited set for the
 * whole run, which keeps document order and emits each row once.
 */

/** Past this much decoded payload the page is treated as pathological, not parsed. */
const MAX_PAYLOAD_CHARS = 5_000_000;
const MAX_DEPTH = 200;
/** Below this the payload held no real content (a loading shell, a redirect). */
const MIN_CHARS = 200;

const SKIP_TAGS = new Set([
	"script",
	"style",
	"svg",
	"link",
	"meta",
	"title",
	"head",
	"noscript",
	"template",
	"button",
	"input",
	"select",
	"nav",
	"footer",
	"aside",
]);

/** Containers whose text must not run into the next block's ("2026Create a new app"). */
const BLOCK_TAGS = new Set([
	"div",
	"section",
	"article",
	"main",
	"header",
	"figure",
	"figcaption",
	"details",
	"summary",
	"dl",
	"dt",
	"dd",
]);

const BLOCK_START = /^(#{1,6} |- |```|\| |> )/;
const PUSH_RE = /<script\b[^>]*>\s*self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)\s*<\/script>/g;
/** A flight row reference: `$<hex>` (model), `$L<hex>` (lazy element) or `$@<hex>` (promise). */
const REF_RE = /^\$[L@]?([0-9a-f]+)$/;
/** References inside raw row JSON, including `$<hex>:path` pointers into another row. */
const RAW_REF_RE = /"\$[L@]?([0-9a-f]+)(?=["):])/g;

type Row = { kind: "text"; text: string } | { kind: "json"; raw: string };

interface Ctx {
	/** Bare strings are content only under an element's `children`, not in router state or props. */
	text: boolean;
	code: boolean;
	/** Set inside a <table>: rows collect here instead of being rendered inline. */
	rows?: { cells: string[]; header: boolean }[];
	cells?: string[];
	header?: boolean;
}

/** Advance from `start` over `bytes` UTF-8 bytes; returns the end index (clamped to the string). */
function skipUtf8Bytes(s: string, start: number, bytes: number): number {
	let i = start;
	let n = 0;
	while (i < s.length && n < bytes) {
		const cp = s.codePointAt(i)!;
		n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
		i += cp > 0xffff ? 2 : 1;
	}
	return i;
}

function parseRows(payload: string): Map<string, Row> {
	const rows = new Map<string, Row>();
	let pos = 0;
	while (pos < payload.length) {
		const head = /^([0-9a-f]*):/.exec(payload.slice(pos, pos + 16));
		const lineEnd = payload.indexOf("\n", pos);
		const nextLine = lineEnd === -1 ? payload.length : lineEnd + 1;
		if (!head) {
			pos = nextLine;
			continue;
		}
		const id = head[1];
		const body = pos + head[0].length;
		const text = /^T([0-9a-f]+),/.exec(payload.slice(body, body + 16));
		if (text) {
			const start = body + text[0].length;
			const end = skipUtf8Bytes(payload, start, Number.parseInt(text[1], 16));
			if (id) rows.set(id, { kind: "text", text: payload.slice(start, end) });
			pos = end;
			continue;
		}
		const raw = payload.slice(body, lineEnd === -1 ? payload.length : lineEnd);
		// Other tagged rows (I imports, HL hints, E errors, D debug) carry no page text.
		if (id && /^[[{"\d\-ntf]/.test(raw)) rows.set(id, { kind: "json", raw });
		pos = nextLine;
	}
	return rows;
}

function renderTable(rows: { cells: string[]; header: boolean }[]): string {
	const kept = rows.filter((r) => r.cells.length > 0);
	if (kept.length === 0) return "";
	const width = Math.max(...kept.map((r) => r.cells.length));
	const line = (cells: string[]) => `| ${[...cells, ...Array(width - cells.length).fill("")].join(" | ")} |\n`;
	let headerCount = kept.findIndex((r) => !r.header);
	if (headerCount === -1) headerCount = kept.length;
	let md = "";
	kept.forEach((r, i) => {
		md += line(r.cells);
		if (i === Math.max(headerCount, 1) - 1) md += line(Array(width).fill("---"));
	});
	return `${md}\n`;
}

export function extractRscMarkdown(html: string): string | undefined {
	try {
		if (!html.includes("self.__next_f.push")) return undefined;
		let payload = "";
		for (const match of html.matchAll(PUSH_RE)) {
			try {
				payload += JSON.parse(match[1]) as string;
			} catch {
				// One corrupt push loses only the rows it carried.
			}
			if (payload.length > MAX_PAYLOAD_CHARS) return undefined;
		}
		const rows = parseRows(payload);
		if (rows.size === 0) return undefined;

		const referenced = new Set<string>();
		for (const row of rows.values()) {
			if (row.kind === "json") for (const m of row.raw.matchAll(RAW_REF_RE)) referenced.add(m[1]);
		}

		// Shared by every root: it breaks cycles and keeps an inlined row from rendering twice.
		const visited = new Set<string>();

		function resolve(id: string, ctx: Ctx, depth: number): string {
			const row = rows.get(id);
			// A text row reached from a non-content prop stays unvisited for the `children` that may use it later.
			if (!row || visited.has(id) || (row.kind === "text" && !ctx.text)) return "";
			visited.add(id);
			if (row.kind === "text") return row.text;
			let value: unknown;
			try {
				value = JSON.parse(row.raw);
			} catch {
				return "";
			}
			return render(value, ctx, depth + 1);
		}

		function renderString(s: string, ctx: Ctx, depth: number): string {
			if (s.startsWith("$$")) return ctx.text ? s.slice(1) : "";
			const ref = REF_RE.exec(s);
			if (ref) return resolve(ref[1], ctx, depth);
			// Any other `$` string is a flight sentinel ($undefined, $Sreact.fragment, $7e:props:… pointers).
			if (!ctx.text || s.startsWith("$")) return "";
			if (!ctx.code && !s.trim()) return " ";
			return s;
		}

		function render(node: unknown, ctx: Ctx, depth: number): string {
			if (depth > MAX_DEPTH || node === null || node === undefined) return "";
			if (typeof node === "string") return renderString(node, ctx, depth);
			if (typeof node === "number") return ctx.text ? String(node) : "";
			if (typeof node !== "object") return "";
			if (!Array.isArray(node)) {
				let out = "";
				for (const value of Object.values(node)) out += render(value, { ...ctx, text: false }, depth + 1);
				return out;
			}
			if (node[0] !== "$" || typeof node[1] !== "string") {
				let out = "";
				for (const child of node) {
					const piece = render(child, ctx, depth + 1);
					if (!ctx.code) {
						// JSX whitespace between blocks would otherwise indent the next line.
						if (piece === " " && (out === "" || out.endsWith("\n"))) continue;
						// A rendered block (not a literal string) right after inline text needs its own line.
						if (piece !== child && out && !out.endsWith("\n") && BLOCK_START.test(piece)) out += "\n\n";
					}
					out += piece;
				}
				return out;
			}
			return renderElement(node[1], (node[3] ?? {}) as Record<string, unknown>, ctx, depth);
		}

		function renderElement(tag: string, props: Record<string, unknown>, ctx: Ctx, depth: number): string {
			if (SKIP_TAGS.has(tag)) return "";
			const children = (c: Ctx = ctx) => render(props.children, { ...c, text: true }, depth + 1);
			const href = typeof props.href === "string" ? props.href : undefined;
			const link = (content: string) =>
				href && !href.startsWith("#") && content.trim() ? `[${content.trim()}](${href})` : content;

			// Client components ($L<id> pointing at an import row) render whatever children the server gave them.
			if (tag.startsWith("$")) {
				if (typeof props.language === "string" && !ctx.code) {
					const code = children({ ...ctx, code: true }).replace(/\n+$/, "");
					return code ? `\`\`\`${props.language}\n${code}\n\`\`\`\n\n` : "";
				}
				return link(children());
			}

			switch (tag) {
				case "h1":
				case "h2":
				case "h3":
				case "h4":
				case "h5":
				case "h6": {
					const content = children().trim();
					return content ? `${"#".repeat(Number(tag[1]))} ${content}\n\n` : "";
				}
				case "p": {
					const content = children();
					return ctx.cells ? content : content.trim() ? `${content.trim()}\n\n` : "";
				}
				case "br":
					return "\n";
				case "hr":
					return "---\n\n";
				case "code": {
					const content = children({ ...ctx, code: true });
					return ctx.code || !content ? content : `\`${content}\``;
				}
				case "pre": {
					if (ctx.code) return children();
					const content = children({ ...ctx, code: true }).replace(/\n+$/, "");
					return content ? `\`\`\`\n${content}\n\`\`\`\n\n` : "";
				}
				case "strong":
				case "b": {
					const content = children();
					return content.trim() ? `**${content.trim()}**` : content;
				}
				case "em":
				case "i": {
					const content = children();
					return content.trim() ? `*${content.trim()}*` : content;
				}
				case "li": {
					const content = children().trim();
					return content ? `- ${content.replace(/\n+/g, "\n  ")}\n` : "";
				}
				case "ul":
				case "ol":
					return `${children()}\n`;
				case "blockquote": {
					const content = children().trim();
					return content ? `${content.replace(/^/gm, "> ")}\n\n` : "";
				}
				case "a":
					return link(children());
				case "table": {
					const collected: NonNullable<Ctx["rows"]> = [];
					children({ ...ctx, rows: collected, cells: undefined, header: false });
					return renderTable(collected);
				}
				case "thead":
					return children({ ...ctx, header: true });
				case "tr": {
					if (!ctx.rows) return children();
					const cells: string[] = [];
					children({ ...ctx, cells });
					ctx.rows.push({ cells, header: ctx.header === true });
					return "";
				}
				case "td":
				case "th": {
					const content = children({ ...ctx, cells: undefined });
					if (!ctx.cells) return content;
					ctx.cells.push(
						content
							.trim()
							.replace(/\s*\n\s*/g, " ")
							.replace(/\|/g, "\\|"),
					);
					return "";
				}
				default: {
					if (tag === "div" && (props.role === "alert" || props["data-slot"] === "alert")) {
						const content = children().trim();
						return content ? `${content.replace(/^/gm, "> ")}\n\n` : "";
					}
					const content = children();
					return BLOCK_TAGS.has(tag) && content.trim() && !content.endsWith("\n") ? `${content}\n\n` : content;
				}
			}
		}

		const byId = (a: string, b: string) => Number.parseInt(a, 16) - Number.parseInt(b, 16);
		let roots = [...rows.keys()].filter((id) => !referenced.has(id)).sort(byId);
		// Every row referenced means a cycle with no entry point; start from each row instead.
		if (roots.length === 0) roots = [...rows.keys()].sort(byId);
		const parts: string[] = [];
		for (const id of roots) {
			// A root that is a bare string (a component name, a hint) is not page text.
			const part = resolve(id, { text: false, code: false }, 0).trim();
			if (part && !parts.includes(part)) parts.push(part);
		}
		const markdown = parts
			.join("\n\n")
			.replace(/[ \t]+$/gm, "")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
		return markdown.length >= MIN_CHARS ? markdown : undefined;
	} catch {
		return undefined;
	}
}
