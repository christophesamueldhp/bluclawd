import {
	createLsToolDefinition,
	createReadToolDefinition,
	type ToolRendererResolver,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import transcript from "../ext/transcript/index.ts";

const DOT = process.platform === "darwin" ? "⏺" : "●";

/** Tags each colour so a test can see which token drew what; the same theme renders both sides of a comparison. */
const theme = {
	fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
	bg: (_c: string, t: string) => t,
	bold: (t: string) => `<b>${t}</b>`,
	italic: (t: string) => t,
	underline: (t: string) => t,
} as any;
const plain = (s: string) => s.replace(/<\/?[a-zA-Z]+>/g, "");

/** The resolver the extension registers with a fake pi. */
function resolver(): ToolRendererResolver {
	let registered: ToolRendererResolver | undefined;
	transcript({
		registerToolRenderer: (r: ToolRendererResolver) => {
			registered = r;
		},
	} as any);
	if (!registered) throw new Error("no tool renderer registered");
	return registered;
}

const piRead = createReadToolDefinition("/work");
const readRenderers = (): ToolRenderers => resolver()("read", () => piRead as never) as ToolRenderers;

interface Row {
	args: Record<string, unknown>;
	result?: { content: { type: "text"; text: string }[]; details?: unknown };
	expanded?: boolean;
	isPartial?: boolean;
	isError?: boolean;
}

/** Draws one tool row as pi's ToolExecutionComponent would: the call, then the result once there is one. */
function draw(renderers: ToolRenderers, row: Row): string {
	const context = {
		args: row.args,
		toolCallId: "call-1",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/work",
		executionStarted: true,
		argsComplete: true,
		isPartial: row.isPartial ?? false,
		expanded: row.expanded ?? false,
		showImages: false,
		isError: row.isError ?? false,
	} as any;
	const lines = renderers.renderCall?.(row.args, theme, context).render(120) ?? [];
	if (row.result) {
		const options = { expanded: context.expanded, isPartial: context.isPartial };
		lines.push(...(renderers.renderResult?.(row.result as never, options, theme, context).render(120) ?? []));
	}
	return lines.map((line) => line.trimEnd()).join("\n");
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

describe("collapsed read", () => {
	it("is one call line and a line count", () => {
		const out = draw(readRenderers(), { args: { path: "src/x.ts" }, result: text("a\nb\nc") });
		expect(plain(out)).toBe(`${DOT} Read(src/x.ts)\n  ⎿  Read 3 lines`);
	});

	it("colours the dot dim while running, accent on success and error on failure", () => {
		const dot = (row: Omit<Row, "args">) => draw(readRenderers(), { args: { path: "x.ts" }, ...row }).split(DOT)[0];
		expect(dot({ isPartial: true })).toBe("<dim>");
		expect(dot({ result: text("a") })).toBe("<accent>");
		expect(dot({ result: text("ENOENT: no such file"), isError: true })).toBe("<error>");
	});

	it("shows a path outside the working directory in full", () => {
		const out = draw(readRenderers(), { args: { path: "/etc/hosts" }, isPartial: true });
		expect(plain(out)).toBe(`${DOT} Read(/etc/hosts)`);
	});

	it("counts the lines read, not pi's continuation notice or the final newline", () => {
		const limited = text("a\nb\n\n[5 more lines in file. Use offset=3 to continue.]");
		expect(plain(draw(readRenderers(), { args: { path: "x.ts", limit: 2 }, result: limited }))).toContain(
			"⎿  Read 2 lines",
		);
		expect(plain(draw(readRenderers(), { args: { path: "x.ts" }, result: text("one\n") }))).toContain(
			"⎿  Read 1 line",
		);
		const toml = text("[a]\nx = 1\n\n[tool.x]");
		expect(plain(draw(readRenderers(), { args: { path: "x.toml" }, result: toml }))).toContain("⎿  Read 4 lines");
		const truncated = {
			...text("…\n\n[Showing lines 1-2000 of 5000. Use offset=2001 to continue.]"),
			details: { truncation: { truncated: true, truncatedBy: "lines", outputLines: 2000, totalLines: 5000 } },
		};
		expect(plain(draw(readRenderers(), { args: { path: "x.ts" }, result: truncated }))).toContain(
			"⎿  Read 2000 lines",
		);
	});

	it("never folds an error: pi's error output stays under the call line", () => {
		const out = draw(readRenderers(), {
			args: { path: "x.ts" },
			result: text("ENOENT: no such file"),
			isError: true,
		});
		expect(plain(out)).toContain(`${DOT} Read(x.ts)`);
		expect(plain(out)).toContain("ENOENT: no such file");
		expect(out).not.toContain("⎿");
	});
});

describe("expanded read", () => {
	it("renders exactly as pi renders it", () => {
		const row: Row = { args: { path: "src/x.ts", offset: 2 }, result: text("b\nc"), expanded: true };
		expect(draw(readRenderers(), row)).toBe(draw(piRead as never, row));
		expect(plain(draw(piRead as never, row))).toContain("read src/x.ts:2");
	});
});

describe("a tool bluclawd does not restyle", () => {
	it("keeps pi's renderers, untouched", () => {
		const pis: ToolRenderers = { renderCall: () => ({ render: () => ["pi's"], invalidate: () => {} }) };
		expect(resolver()("some_mcp_tool", () => pis)).toBe(pis);
		expect(resolver()("some_mcp_tool", () => undefined)).toBeUndefined();
	});

	it("renders exactly as pi renders it, collapsed and expanded", () => {
		const piLs = createLsToolDefinition("/work") as never;
		const ls = resolver()("ls", () => piLs) as ToolRenderers;
		for (const expanded of [false, true]) {
			const row: Row = { args: { path: "src" }, result: text("a.ts\nb.ts"), expanded };
			expect(draw(ls, row)).toBe(draw(piLs, row));
		}
	});
});
