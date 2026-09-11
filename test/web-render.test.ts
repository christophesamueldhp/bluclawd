import { describe, expect, it } from "vitest";
import {
	formatSearchResultsForDisplay,
	renderWebfetchCall,
	renderWebfetchResult,
	renderWebsearchCall,
	renderWebsearchResult,
} from "../ext/web/render.ts";

// Minimal Theme stand-in: enough for the renderers, which only call `fg` and `bold`.
const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;

// Wide enough that Text never wraps a long line, so content assertions below
// don't have to account for inserted line breaks.
function textOf(component: { render: (width: number) => string[] }): string {
	return component.render(100_000).join("\n");
}

describe("webfetch rendering", () => {
	it("renders the call as the url", () => {
		expect(textOf(renderWebfetchCall({ url: "https://example.com/a" }, theme))).toContain("https://example.com/a");
	});

	it("collapses a raw fetch to a one-line summary with an expand hint, hiding the page body", () => {
		const result = {
			content: [{ type: "text" as const, text: "a".repeat(5000) }],
			details: { url: "https://example.com/", contentType: "text/html", bytes: 5000, truncated: false },
		};
		const collapsed = textOf(
			renderWebfetchResult(result, { expanded: false, isPartial: false }, theme, { isError: false }),
		);
		expect(collapsed).not.toContain("a".repeat(5000));
		expect(collapsed).toContain("https://example.com/");
		expect(collapsed).toContain("expand");
		const expanded = textOf(
			renderWebfetchResult(result, { expanded: true, isPartial: false }, theme, { isError: false }),
		);
		expect(expanded).toContain("a".repeat(5000));
	});

	it("shows cached/truncated flags when collapsed", () => {
		const result = {
			content: [{ type: "text" as const, text: "x" }],
			details: { url: "https://x/", contentType: "text/plain", bytes: 10, truncated: true, cached: true },
		};
		const text = textOf(
			renderWebfetchResult(result, { expanded: false, isPartial: false }, theme, { isError: false }),
		);
		expect(text).toContain("cached");
		expect(text).toContain("truncated");
	});

	it("never collapses a redirect notice or a model analysis", () => {
		const redirect = {
			content: [{ type: "text" as const, text: "REDIRECT DETECTED: ..." }],
			details: { url: "https://a/", contentType: "", bytes: 0, truncated: false, redirectedTo: "https://b/" },
		};
		expect(
			textOf(renderWebfetchResult(redirect, { expanded: false, isPartial: false }, theme, { isError: false })),
		).toContain("REDIRECT DETECTED");

		const analyzed = {
			content: [{ type: "text" as const, text: "The page says X." }],
			details: { url: "https://a/", contentType: "text/html", bytes: 999, truncated: false, analyzed: true },
		};
		expect(
			textOf(renderWebfetchResult(analyzed, { expanded: false, isPartial: false }, theme, { isError: false })),
		).toContain("The page says X.");
	});

	it("shows the raw error text on a failed fetch, even collapsed", () => {
		const errored = {
			content: [{ type: "text" as const, text: "webfetch: 404 for https://x/" }],
			details: undefined,
			isError: true,
		};
		expect(
			textOf(
				renderWebfetchResult(errored as never, { expanded: false, isPartial: false }, theme, { isError: true }),
			),
		).toContain("404");
	});
});

describe("websearch rendering", () => {
	it("renders the call as the query", () => {
		expect(textOf(renderWebsearchCall({ query: "typescript 5.9" }, theme))).toContain("typescript 5.9");
	});

	it("collapses to a result count and expands to the full list", () => {
		const results = [
			{ title: "A", url: "https://a/", snippet: "sa" },
			{ title: "B", url: "https://b/", snippet: "sb" },
		];
		const result = { content: [{ type: "text" as const, text: "irrelevant wrapper" }], details: results };
		const collapsed = textOf(
			renderWebsearchResult(result, { expanded: false, isPartial: false }, theme, { isError: false }),
		);
		expect(collapsed).toContain("2 results");
		expect(collapsed).not.toContain("https://a/");
		const expanded = textOf(
			renderWebsearchResult(result, { expanded: true, isPartial: false }, theme, { isError: false }),
		);
		expect(expanded).toContain("https://a/");
		expect(expanded).toContain("https://b/");
		expect(expanded).not.toContain("<untrusted-search-results");
	});

	it("shows a configure/error message instead of '0 results'", () => {
		const result = { content: [{ type: "text" as const, text: "Web search needs an API key." }], details: [] };
		expect(
			textOf(renderWebsearchResult(result, { expanded: false, isPartial: false }, theme, { isError: false })),
		).toContain("needs an API key");
	});

	it("formatSearchResultsForDisplay renders published dates and omits empty snippets", () => {
		const out = formatSearchResultsForDisplay([
			{ title: "T", url: "https://t/", snippet: "", published: "2026-01-02" },
		]);
		expect(out).toBe("1. T (2026-01-02)\n   https://t/");
	});
});
