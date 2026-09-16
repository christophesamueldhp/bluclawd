/**
 * Main-content extraction for `webfetch`: Mozilla Readability (the Firefox
 * Reader View algorithm) over a linkedom DOM, then the same `htmlToMarkdown`
 * the whole-page path uses, so tables and code blocks convert identically.
 *
 * Readability is tuned for articles. On a docs index, a search page or a link
 * list it can keep a sliver of what matters, so its output is only used when it
 * is substantial on its own AND a real share of the whole page; otherwise the
 * whole page (minus the chrome `htmlToMarkdown` already strips) is returned.
 */

import { htmlToMarkdown } from "./html-to-md.ts";

/** Below this, extraction probably missed the content (pi-web-access uses the same floor). */
const MIN_CHARS = 500;
/** Below this share of the whole-page text, extraction probably gutted a non-article page. */
const MIN_SHARE = 0.25;

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function readableMarkdown(html: string): Promise<string> {
	const whole = htmlToMarkdown(html);
	try {
		// Loaded on first use: a DOM implementation is not free to import.
		const [{ parseHTML }, { Readability }] = await Promise.all([import("linkedom"), import("@mozilla/readability")]);
		const { document } = parseHTML(html);
		const article = new Readability(document as unknown as Document).parse();
		if (!article?.content) return whole;
		// Readability lifts the title out of the content; put it back as the heading.
		const title = article.title && !/<h1\b/i.test(article.content) ? `<h1>${escapeHtml(article.title)}</h1>` : "";
		const main = htmlToMarkdown(title + article.content);
		return main.length >= MIN_CHARS && main.length >= whole.length * MIN_SHARE ? main : whole;
	} catch {
		return whole;
	}
}
