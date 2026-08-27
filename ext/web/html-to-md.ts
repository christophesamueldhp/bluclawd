/**
 * Tiny, dependency-free HTML -> Markdown converter for `webfetch` (PLAN.md F4.2).
 *
 * This is a pragmatic regex/string scan, NOT a spec-compliant parser. It exists
 * only to turn a fetched web page into readable Markdown for the model, so it
 * favours resilience over fidelity: it must never throw, even on malformed HTML,
 * and it drops anything it can't confidently convert.
 *
 * Conversions: strips <script>/<style>/<head>/<nav>/<noscript> (with content) and
 * HTML comments; headings -> #..######; <a href> -> [text](href); <ul>/<ol>/<li>
 * -> `- `/`1. `; <pre> -> fenced code, <code> -> inline code; <blockquote> -> `> `;
 * <p>/<br> -> line breaks; <strong>/<b> -> **, <em>/<i> -> *. All other tags are
 * stripped, keeping their text. Common HTML entities are decoded.
 */

/** Decode the common HTML entities plus numeric (&#NN; / &#xHH;) references. Never throws. */
function decodeEntities(input: string): string {
	return input.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, entity: string) => {
		switch (entity) {
			case "amp":
				return "&";
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "quot":
				return '"';
			case "apos":
				return "'";
			case "nbsp":
				return " ";
		}
		if (entity[0] === "#") {
			const code = entity[1] === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
			if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
				try {
					return String.fromCodePoint(code);
				} catch {
					return match;
				}
			}
		}
		return match; // unknown named entity: leave as-is
	});
}

/** Remove every tag, keeping the text between them. */
function stripTags(html: string): string {
	return html.replace(/<[^>]*>/g, "");
}

/** Collapse an inline fragment to a single trimmed line of plain text. */
function collapseInline(html: string): string {
	return stripTags(html).replace(/\s+/g, " ").trim();
}

// Sentinel byte used to fence off already-rendered code so later rules can't
// mangle it. NUL never occurs in HTML text and survives tag-stripping, entity
// decoding, and whitespace tidying untouched. Built at runtime to keep the
// source file plain ASCII.
const NUL = String.fromCharCode(0);

/**
 * Convert an HTML string to Markdown. Best-effort and non-throwing.
 */
export function htmlToMarkdown(html: string): string {
	try {
		let s = html;

		// 1. Drop comments and elements whose content is not prose.
		s = s.replace(/<!--[\s\S]*?-->/g, "");
		s = s.replace(/<(script|style|head|nav|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, "");

		// 2. Protect code blocks: convert them now and stash the result behind a
		//    sentinel placeholder so the later inline/block rules leave them alone.
		const stash: string[] = [];
		const protect = (rendered: string): string => {
			stash.push(rendered);
			return `${NUL}${stash.length - 1}${NUL}`;
		};
		s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
			const code = decodeEntities(stripTags(inner)).replace(/^\n+|\n+$/g, "");
			return `\n\n${protect(`\`\`\`\n${code}\n\`\`\``)}\n\n`;
		});
		s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) =>
			protect(`\`${decodeEntities(stripTags(inner))}\``),
		);

		// 3. Inline formatting (before block rules that flatten their inner HTML).
		s = s.replace(
			/<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi,
			(_m, _raw, dq: string, sq: string, uq: string, text: string) => {
				const href = (dq ?? sq ?? uq ?? "").trim();
				const label = collapseInline(text) || href;
				return href ? `[${label}](${href})` : label;
			},
		);
		s = s.replace(
			/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi,
			(_m, _tag, inner: string) => `**${collapseInline(inner)}**`,
		);
		s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, inner: string) => `*${collapseInline(inner)}*`);

		// 4. Headings (single backreferenced pass, consistent with the inline rules above).
		s = s.replace(
			/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
			(_m, level: string, inner: string) => `\n\n${"#".repeat(Number(level))} ${collapseInline(inner)}\n\n`,
		);

		// 5. Lists. Ordered first (so items number sequentially), then any remaining
		//    <li> is treated as an unordered bullet.
		s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_m, inner: string) => {
			let n = 0;
			const items = inner.replace(
				/<li\b[^>]*>([\s\S]*?)<\/li>/gi,
				(_mm, li: string) => `\n${++n}. ${collapseInline(li)}`,
			);
			return `\n${stripTags(items)}\n`;
		});
		s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${collapseInline(inner)}`);

		// 6. Blockquotes.
		s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner: string) => {
			const text = collapseInline(inner);
			return text ? `\n\n> ${text}\n\n` : "\n\n";
		});

		// 7. Paragraph / line breaks.
		s = s.replace(/<br\s*\/?\s*>/gi, "\n");
		s = s.replace(/<\/p\s*>/gi, "\n\n");
		s = s.replace(/<p\b[^>]*>/gi, "\n\n");

		// 8. Strip everything else, decode entities, tidy whitespace.
		s = stripTags(s);
		s = decodeEntities(s);
		s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");

		// 9. Restore protected code blocks (after tidying, so their internals are untouched).
		s = s.replace(new RegExp(`${NUL}(\\d+)${NUL}`, "g"), (_m, i: string) => stash[Number(i)] ?? "");
		return s.trim();
	} catch {
		// Defensive: the converter must never throw. Fall back to tag-stripped text.
		try {
			return decodeEntities(stripTags(html)).trim();
		} catch {
			return "";
		}
	}
}
