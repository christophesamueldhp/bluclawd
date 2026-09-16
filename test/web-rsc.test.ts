import { describe, expect, it } from "vitest";
import { extractRscMarkdown } from "../ext/web/rsc.ts";

const PARA =
	"Server components render on the server and stream their output to the client as a flight payload, which is what this extractor reads.";

const row = (id: string, value: unknown) => `${id}:${JSON.stringify(value)}\n`;
const el = (tag: string, props: Record<string, unknown> = {}) => ["$", tag, null, props];
const push = (chunk: string, attrs = "") => `<script${attrs}>self.__next_f.push([1,${JSON.stringify(chunk)}])</script>`;
const page = (...scripts: string[]) =>
	`<!doctype html><html><head><title>T</title></head><body><div id="__next"></div>${scripts.join("")}</body></html>`;

describe("extractRscMarkdown", () => {
	it("returns undefined for a page without flight data", () => {
		expect(extractRscMarkdown(`<html><body><h1>Plain</h1><p>${PARA.repeat(3)}</p></body></html>`)).toBeUndefined();
	});

	it("converts headings, links, code, lists and tables, resolving $L references", () => {
		const payload =
			row("1", "$Sreact.fragment") +
			`2:I[1234,["chunk.js"],"Link"]\n` +
			row("0", {
				P: null,
				c: ["", "docs", "guide"],
				t: { d: { r: el("$1", { children: el("main", { children: ["$L3", "$L4"] }) }) } },
			}) +
			row(
				"3",
				el("article", {
					children: [
						el("h1", { children: "Getting Started" }),
						el("p", {
							children: [PARA, " See ", el("$L2", { href: "/docs/next", children: "the next page" }), "."],
						}),
						el("ul", { children: ["\n", el("li", { children: "one" }), "\n", el("li", { children: "two" })] }),
					],
				}),
			) +
			row(
				"4",
				el("div", {
					children: [
						el("p", { children: ["Run ", el("code", { children: "npm install" }), " first."] }),
						el("pre", { children: el("code", { children: ["const a = 1;", "\n", "const b = 2;"] }) }),
						el("table", {
							children: [
								el("thead", {
									children: el("tr", {
										children: [el("th", { children: "Name" }), el("th", { children: "Type" })],
									}),
								}),
								el("tbody", {
									children: el("tr", {
										children: [el("td", { children: "a|b" }), el("td", { children: "string" })],
									}),
								}),
							],
						}),
						el("nav", { children: "Skip me" }),
					],
				}),
			);
		const md = extractRscMarkdown(page(push(payload)));
		expect(md).toBeDefined();
		expect(md).toContain("# Getting Started");
		expect(md).toContain("[the next page](/docs/next)");
		expect(md).toContain("- one\n- two");
		expect(md).toContain("Run `npm install` first.");
		expect(md).toContain("```\nconst a = 1;\nconst b = 2;\n```");
		expect(md).toContain("| Name | Type |\n| --- | --- |\n| a\\|b | string |");
		expect(md).not.toContain("Skip me");
		// Router state and import rows are not page text.
		expect(md).not.toMatch(/docsguide|chunk\.js|Sreact/);
		expect(md!.indexOf("Getting Started")).toBeLessThan(md!.indexOf("npm install"));
	});

	it("accepts script tags with attributes such as a CSP nonce", () => {
		const payload = row(
			"0",
			el("article", { children: [el("h1", { children: "Nonce" }), el("p", { children: PARA.repeat(2) })] }),
		);
		expect(extractRscMarkdown(page(push(payload, ' nonce="abc"')))).toContain("# Nonce");
	});

	it("terminates on reference cycles and emits each row once", () => {
		const payload =
			row("5", el("section", { children: [el("h2", { children: "Loop A" }), el("p", { children: PARA }), "$L6"] })) +
			row("6", el("section", { children: [el("h2", { children: "Loop B" }), el("p", { children: PARA }), "$L5"] }));
		const md = extractRscMarkdown(page(push(payload)));
		expect(md).toContain("## Loop A");
		expect(md).toContain("## Loop B");
		expect(md!.split("Loop A").length - 1).toBe(1);
	});

	it("emits a row inlined by its parent once, in document order", () => {
		const payload =
			row("a", el("div", { children: [el("h1", { children: "Parent" }), "$Lb", "$Lc"] })) +
			row("b", el("p", { children: `First. ${PARA}` })) +
			row("c", el("p", { children: `Second. ${PARA}` }));
		const md = extractRscMarkdown(page(push(payload)))!;
		expect(md.split("First.").length - 1).toBe(1);
		expect(md.split("Second.").length - 1).toBe(1);
		expect(md.indexOf("Parent")).toBeLessThan(md.indexOf("First."));
		expect(md.indexOf("First.")).toBeLessThan(md.indexOf("Second."));
	});

	it("parses rows split across pushes", () => {
		const payload = row(
			"0",
			el("article", { children: [el("h1", { children: "Split" }), el("p", { children: PARA.repeat(2) })] }),
		);
		const cut = Math.floor(payload.length / 2);
		expect(extractRscMarkdown(page(push(payload.slice(0, cut)), push(payload.slice(cut))))).toContain("# Split");
	});

	it("reads T text rows by UTF-8 byte length, even with a row following on the same line", () => {
		const text = `Caf\u00e9 \u2014 ${PARA} \u{1F680} ${PARA}`;
		const bytes = Buffer.byteLength(text, "utf8").toString(16);
		const payload = `7:T${bytes},${text}${row("8", el("article", { children: [el("h1", { children: "Text rows" }), el("p", { children: "$7" })] }))}`;
		const md = extractRscMarkdown(page(push(payload)))!;
		expect(md).toContain("# Text rows");
		expect(md).toContain(text);
	});

	it("unescapes $$ strings and drops flight sentinels and path pointers", () => {
		const payload = row(
			"0",
			el("article", {
				children: [
					el("h1", { children: "Prices" }),
					el("p", { children: ["$$5 per month. ", PARA, PARA] }),
					el("p", { children: ["$undefined", "$0:props:children", "$@9", PARA] }),
				],
			}),
		);
		const md = extractRscMarkdown(page(push(payload)))!;
		expect(md).toContain("$5 per month.");
		expect(md).not.toMatch(/\$undefined|props:children|\$@9/);
	});

	it("returns undefined, without throwing, on malformed payloads", () => {
		const cases = [
			page(push('0:["$","h1",null,{"children":')),
			page(`<script>self.__next_f.push([1,"\\x-not-json"])</script>`),
			page(push("zz:not a row\n\u0000\u0001garbage")),
			page(push(`1:T${"f".repeat(12)},short`)),
			page(push(row("0", ["$", "$L0", null, { children: "$L0" }]))),
		];
		for (const html of cases) expect(() => extractRscMarkdown(html)).not.toThrow();
		for (const html of cases) expect(extractRscMarkdown(html)).toBeUndefined();
	});

	it("returns undefined when the content is under 200 chars", () => {
		const payload = row(
			"0",
			el("article", { children: [el("h1", { children: "Short" }), el("p", { children: "Loading..." })] }),
		);
		expect(extractRscMarkdown(page(push(payload)))).toBeUndefined();
	});

	it("gives up on a payload over the size cap", () => {
		const payload = row(
			"0",
			el("article", { children: [el("h1", { children: "Huge" }), el("p", { children: "x".repeat(5_100_000) })] }),
		);
		expect(extractRscMarkdown(page(push(payload)))).toBeUndefined();
	});

	it("survives nesting deeper than the recursion limit", () => {
		let node: unknown = el("p", { children: PARA.repeat(2) });
		for (let i = 0; i < 1000; i++) node = el("div", { children: node });
		const html = page(
			push(
				row(
					"0",
					el("article", {
						children: [el("h1", { children: "Shallow" }), el("p", { children: PARA.repeat(2) }), node],
					}),
				),
			),
		);
		expect(() => extractRscMarkdown(html)).not.toThrow();
		expect(extractRscMarkdown(html)).toContain("# Shallow");
	});
});
