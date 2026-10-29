import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startRemoteServer } from "../daemon/remote/http.ts";
import { RemoteStore } from "../daemon/remote/pairing.ts";
import { markdown } from "../daemon/remote/web/markdown.js";

const WEB_DIR = join(import.meta.dirname, "../daemon/remote/web");

describe("the app's modules", () => {
	it("serves markdown.js as a script", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bluclawd-markdown-"));
		const server = await startRemoteServer(
			{
				store: new RemoteStore(join(dir, "remote.json")),
				webDir: WEB_DIR,
				listInstances: () => [],
				send: () => false,
				launch: () => undefined,
				startSession: () => "",
				terminalOpen: () => true,
				renameInstance: () => false,
				setPinned: () => false,
				deleteInstance: () => false,
				report: () => undefined,
			},
			0,
		);
		try {
			const res = await fetch(`http://127.0.0.1:${server.port}/markdown.js`);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		} finally {
			await server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/** Every tag the renderer may emit, with only the attributes it may give them. */
const ALLOWED_TAG =
	/^<\/?(?:p|br|h[1-6]|strong|em|del|code|pre|blockquote|ul|ol|li|hr|table|thead|tbody|tr|th|td|div|span|a|input)(?: (?:class="[a-z ]+"|start="\d+"|type="checkbox"|disabled|checked|href="https?:\/\/[^"]*"|target="_blank"|rel="noopener noreferrer"))*>$/;

function tagsOf(html: string): string[] {
	return html.match(/<[^>]*>/g) ?? [];
}

function expectSafe(html: string): void {
	expect(tagsOf(html).filter((tag) => !ALLOWED_TAG.test(tag))).toEqual([]);
}

describe("markdown (the phone's rendering of a reply)", () => {
	it("renders headings, paragraphs and line breaks", () => {
		expect(markdown("# Title\n\nFirst line\nsecond line\n\n### Small ##")).toBe(
			"<h1>Title</h1><p>First line<br>second line</p><h3>Small</h3>",
		);
	});

	it("renders bold, italic, strikethrough and inline code", () => {
		expect(markdown("**b** *i* __b__ _i_ ~~gone~~ `x < y` ***both***")).toBe(
			"<p><strong>b</strong> <em>i</em> <strong>b</strong> <em>i</em> <del>gone</del> <code>x &#60; y</code> <strong><em>both</em></strong></p>",
		);
	});

	it("leaves snake_case, a lone star and spaced stars alone", () => {
		expect(markdown("snake_case_name and 2 * 3 * 4 and a*")).toBe("<p>snake_case_name and 2 * 3 * 4 and a*</p>");
	});

	it("keeps formatting out of code spans and honours backslash escapes", () => {
		expect(markdown("`**not bold**` \\*not em\\* ``a ` b``")).toBe(
			"<p><code>**not bold**</code> *not em* <code>a ` b</code></p>",
		);
	});

	it("renders http(s) links that open apart from the app", () => {
		expect(markdown("[the **docs**](https://example.com/a?b=1&c=2) and https://x.dev/p.")).toBe(
			'<p><a href="https://example.com/a?b=1&#38;c=2" target="_blank" rel="noopener noreferrer">the <strong>docs</strong></a> and <a href="https://x.dev/p" target="_blank" rel="noopener noreferrer">https://x.dev/p</a>.</p>',
		);
	});

	it("renders bullet, numbered and nested lists", () => {
		expect(markdown("- a\n- b\n  - c\n    1. d\n- e")).toBe(
			"<ul><li>a</li><li>b<ul><li>c<ol><li>d</li></ol></li></ul></li><li>e</li></ul>",
		);
		expect(markdown("3. three\n4. four")).toBe('<ol start="3"><li>three</li><li>four</li></ol>');
		expect(markdown("1. one\n\n2. two")).toBe("<ol><li><p>one</p></li><li><p>two</p></li></ol>");
	});

	it("lets a list follow a paragraph line and takes a lazy continuation line", () => {
		expect(markdown("Steps:\n- one\ncontinued\n- two")).toBe(
			"<p>Steps:</p><ul><li>one<br>continued</li><li>two</li></ul>",
		);
	});

	it("renders task lists with disabled boxes", () => {
		expect(markdown("- [ ] todo\n- [x] done")).toBe(
			'<ul><li class="task"><input type="checkbox" disabled> todo</li><li class="task"><input type="checkbox" disabled checked> done</li></ul>',
		);
	});

	it("renders blockquotes, nested ones too", () => {
		expect(markdown("> quoted *text*\n> > deeper")).toBe(
			"<blockquote><p>quoted <em>text</em></p><blockquote><p>deeper</p></blockquote></blockquote>",
		);
	});

	it("renders fenced code with its language, escaped and unformatted", () => {
		expect(markdown("```ts\nconst a = <T>(x: T) => **x**;\n```\nafter")).toBe(
			'<div class="code"><div class="lang">ts</div><pre><code>const a = &#60;T&#62;(x: T) =&#62; **x**;</code></pre></div><p>after</p>',
		);
		expect(markdown("~~~\nplain\n~~~")).toBe('<div class="code"><pre><code>plain</code></pre></div>');
	});

	it("renders fenced code inside a list item", () => {
		expect(markdown("1. run:\n   ```sh\n   npm test\n   ```")).toBe(
			'<ol><li>run:<div class="code"><div class="lang">sh</div><pre><code>npm test</code></pre></div></li></ol>',
		);
	});

	it("renders horizontal rules", () => {
		expect(markdown("a\n\n---\n\n* * *\nb")).toBe("<p>a</p><hr><hr><p>b</p>");
	});

	it("renders GitHub tables with alignment, in a scrolling container", () => {
		expect(markdown("| Name | Size | Note |\n|:-----|-----:|:----:|\n| `a\\|b` | 1 | **x** |\n| c |")).toBe(
			'<div class="table"><table><thead><tr><th class="l">Name</th><th class="r">Size</th><th class="c">Note</th></tr></thead>' +
				'<tbody><tr><td class="l"><code>a|b</code></td><td class="r">1</td><td class="c"><strong>x</strong></td></tr>' +
				'<tr><td class="l">c</td><td class="r"></td><td class="c"></td></tr></tbody></table></div>',
		);
	});

	it("is not a table without a delimiter row matching the header", () => {
		expect(markdown("a | b\n--- | --- | ---")).toBe("<p>a | b<br>--- | --- | ---</p>");
	});

	describe("while it streams", () => {
		it("shows an unclosed fence as code to the end", () => {
			expect(markdown("Here:\n```js\nlet a = 1;\nlet b")).toBe(
				'<p>Here:</p><div class="code"><div class="lang">js</div><pre><code>let a = 1;\nlet b</code></pre></div>',
			);
		});

		it("shows an unclosed bold, code span or link as it is", () => {
			expect(markdown("so **far `tick [link](ex")).toBe("<p>so **far `tick [link](ex</p>");
		});

		it("renders the closed parts before an unclosed one", () => {
			expect(markdown("**a** and **b")).toBe("<p><strong>a</strong> and **b</p>");
		});
	});

	describe("against injection", () => {
		const attacks = [
			"<script>alert(1)</script>",
			"<img src=x onerror=alert(1)>",
			"[x](javascript:alert(1))",
			"[x](JavaScript:alert(1))",
			"[x]( javascript:alert(1) )",
			"[x](data:text/html,<script>alert(1)</script>)",
			"[x](vbscript:msgbox)",
			'[x](https://a.dev/" onmouseover="alert(1))',
			"[x](https://a.dev/'onmouseover='alert(1))",
			"[<img src=x onerror=alert(1)>](https://a.dev)",
			'[a"b](https://a.dev "t\\" onclick=\\"x")',
			"![x](https://evil.dev/pixel.png)",
			'```"><script>alert(1)</script>\n```',
			"```js onload=alert(1)\nx\n```",
			"| <b>h</b> |\n|---|\n| <i>c</i> |",
			"- [x] <script>",
			"> <iframe src=javascript:alert(1)>",
			"`</code><script>`",
			"**<svg onload=alert(1)>**",
			"https://a.dev/<script>",
			'https://a.dev/"onmouseover="x',
			"\u0000 0 \u0000",
			"\\<script>",
		];

		it.each(attacks)("emits only its own tags for %j", (input) => {
			const html = markdown(input);
			expectSafe(html);
			expect(html).not.toMatch(/<(?:script|img|svg|iframe|b|i)\b/i);
		});

		it("links only http(s) URLs", () => {
			expect(markdown("[x](javascript:void0)")).toBe("<p>x</p>");
			expect(markdown("[x](javascript:alert(1))")).toBe("<p>[x](javascript:alert(1))</p>");
			expect(markdown("[x](ftp://a.dev)")).toBe("<p>x</p>");
			expect(markdown("![alt](https://a.dev/i.png)")).toBe(
				'<p><a href="https://a.dev/i.png" target="_blank" rel="noopener noreferrer">alt</a></p>',
			);
		});

		it("caps nesting instead of recursing without end", () => {
			const html = markdown(
				`${"> ".repeat(5000)}deep\n${Array.from({ length: 300 }, (_, i) => `${"  ".repeat(i)}- x`).join("\n")}`,
			);
			expectSafe(html);
			expect(html).toContain("deep");
		});
	});

	describe("on huge input", () => {
		const cases: Array<[string, string]> = [
			["unmatched brackets", "[".repeat(100_000)],
			["bracket and text", "[a".repeat(50_000)],
			["link openers", "[a](".repeat(30_000)],
			["stars", "*".repeat(100_000)],
			["star words", "*a ".repeat(40_000)],
			["underscores", "_a".repeat(50_000)],
			["backticks", "`a``".repeat(30_000)],
			["urls", "https://a.dev/".repeat(10_000)],
			["pipes", `${"|".repeat(50_000)}\n${"|-".repeat(25_000)}`],
			["quote markers", ">".repeat(100_000)],
			["list lines", "- a\n".repeat(20_000)],
			["fences", "```\n".repeat(20_000)],
			[
				"a long reply",
				"## Head\n\nSome **bold** text with `code` and [a link](https://a.dev).\n\n- one\n- two\n\n```js\nx\n```\n\n".repeat(
					2000,
				),
			],
		];

		it.each(cases)("renders %s quickly", (_name, input) => {
			const start = performance.now();
			const html = markdown(input);
			expect(performance.now() - start).toBeLessThan(1000);
			expectSafe(html);
		});
	});
});
