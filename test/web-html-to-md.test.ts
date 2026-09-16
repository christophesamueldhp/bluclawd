import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../ext/web/html-to-md.ts";

describe("htmlToMarkdown", () => {
	it("keeps the conversions the model already relies on", () => {
		const md = htmlToMarkdown(
			`<html><head><title>T</title><script>x()</script></head><body>
			<nav>menu</nav><h1>Title</h1><p>Hello <a href="/x">link</a> &amp; <b>bold</b></p>
			<ul><li>one</li><li>two</li></ul><pre><code>a &lt; b</code></pre></body></html>`,
		);
		expect(md).toContain("# Title");
		expect(md).toContain("Hello [link](/x) & **bold**");
		expect(md).toContain("- one\n- two");
		expect(md).toContain("```\na < b\n```");
		expect(md).not.toContain("menu");
		expect(md).not.toContain("x()");
	});

	it("renders tables as GFM pipe tables with a header separator", () => {
		const md = htmlToMarkdown(
			`<table><thead><tr><th>Name</th><th>Price</th></tr></thead>
			<tbody><tr><td>Pro</td><td>$20 <a href="/pro">details</a></td></tr>
			<tr><td>Team</td><td>$40</td></tr></tbody></table>`,
		);
		expect(md).toBe(
			["| Name | Price |", "| --- | --- |", "| Pro | $20 [details](/pro) |", "| Team | $40 |"].join("\n"),
		);
	});

	it("gives a header-less table a separator after its first row and escapes pipes in cells", () => {
		const md = htmlToMarkdown("<table><tr><td>a|b</td><td>c</td></tr><tr><td>d</td><td>e</td></tr></table>");
		expect(md).toBe(["| a\\|b | c |", "| --- | --- |", "| d | e |"].join("\n"));
	});

	it("keeps inline code inside table cells intact", () => {
		const md = htmlToMarkdown("<table><tr><th>Flag</th></tr><tr><td><code>--all</code></td></tr></table>");
		expect(md).toContain("| `--all` |");
	});

	it("renders <hr> as a thematic break and drops footer/aside/iframe", () => {
		const md = htmlToMarkdown(
			'<p>body</p><hr><aside>side</aside><footer>foot</footer><iframe src="x">frame</iframe><p>more</p>',
		);
		expect(md).toBe("body\n\n---\n\nmore");
	});
	it("keeps a link's label but drops javascript: and data: targets", () => {
		const md = htmlToMarkdown(
			`<p><a href="javascript:alert(1)">run</a> <a href="DATA:text/html;base64,PHNjcmlwdD4=">blob</a> <a href="https://ok.example/">ok</a></p>`,
		);
		expect(md).toBe("run blob [ok](https://ok.example/)");
	});

	it("uses <title> as the heading when the page has no <h1>", () => {
		expect(htmlToMarkdown("<html><head><title>Docs &amp; API</title></head><body><p>x</p></body></html>")).toBe(
			"# Docs & API\n\nx",
		);
		expect(htmlToMarkdown("<head><title>T</title></head><h1>Main</h1>")).toBe("# Main");
	});
	it("removes a nested chrome element whole, not just up to its first inner close tag", () => {
		expect(htmlToMarkdown("<aside>a<aside>b</aside>c</aside><p>keep</p>")).toBe("keep");
	});
	it("does not leak attribute text when a quoted attribute value contains >", () => {
		expect(
			htmlToMarkdown(
				`<p><span data-mw='{"wt":"a > b"}' title="x>y">text</span> <a href="/q?a>b" data-j='{"k":">"}'>go</a></p>`,
			),
		).toBe("text [go](/q?a>b)");
	});
});
