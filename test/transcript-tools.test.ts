import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackgroundBashTool } from "../ext/background-bash/bash-tool.ts";
import { contextFor, DOT, draw, plain, type Row, restyled, text, theme } from "./helpers/tool-render.ts";

const piBash = createBashToolDefinition("/work");
const bash = () => restyled("bash", piBash);
const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

describe("collapsed bash", () => {
	it("is the call line, the last 3 output lines and how many came before", () => {
		const out = draw(bash(), { args: { command: "npm test" }, result: text("1\n2\n3\n4\n5\n6") });
		expect(plain(out)).toBe(`${DOT} Bash(npm test)\n  ⎿  4\n     5\n     6\n     … +3 lines`);
	});

	it("never folds a failed command: every output line stays under the call line", () => {
		const failed = text(`${numbered(10)}\n\nCommand exited with code 1`);
		const out = plain(draw(bash(), { args: { command: "npm test" }, result: failed, isError: true }));
		expect(out.split("\n")[0]).toBe(`${DOT} Bash(npm test)`);
		for (let i = 1; i <= 10; i++) expect(out).toContain(`line ${i}\n`);
		expect(out).toContain("Command exited with code 1");
		expect(out).not.toContain("earlier lines");
	});

	it("counts the lines pi cut from a truncated output, and drops its footer", () => {
		const truncated = text(`${numbered(3)}\n\n[Showing lines 4998-5000 of 5000. Full output: /tmp/out.log]`, {
			truncation: { truncated: true, truncatedBy: "lines", totalLines: 5000, outputLines: 3 },
			fullOutputPath: "/tmp/out.log",
		});
		const out = plain(draw(bash(), { args: { command: "build" }, result: truncated }));
		expect(out).toBe(`${DOT} Bash(build)\n  ⎿  line 1\n     line 2\n     line 3\n     … +4997 lines`);
	});

	it("shows the latest lines while the command runs", () => {
		const out = plain(draw(bash(), { args: { command: "npm test" }, result: text("a\nb"), isPartial: true }));
		expect(out).toBe(`${DOT} Bash(npm test)\n  ⎿  a\n     b`);
	});

	it("cuts a long line to the width instead of wrapping it", () => {
		const out = plain(draw(bash(), { args: { command: "cat x" }, result: text("x".repeat(200)) }, 80));
		expect(out.split("\n")).toHaveLength(2);
	});

	it("still says a command sent to the background runs there", () => {
		const bluclawdBash = createBackgroundBashTool({
			cwd: "/work",
			operations: { exec: async () => ({ exitCode: 0 }) },
			sendMessage: () => {},
			isMain: true,
		});
		const started = text("Command running in background with ID: b1. Output is being written to: /tmp/b1.", {
			backgroundTaskId: "b1",
		});
		const out = plain(draw(restyled("bash", bluclawdBash), { args: { command: "npm run dev" }, result: started }));
		expect(out).toBe(`${DOT} Bash(npm run dev)\n  ⎿  Running in the background (↓ to manage)`);
	});
});

describe("expanded bash", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("renders exactly as pi renders it", () => {
		const row: Row = { args: { command: "npm test" }, result: text(numbered(10)), expanded: true };
		expect(draw(bash(), row)).toBe(draw(piBash as never, row));
	});

	/** One bash row drawn over time, as pi's tool row does: same state, each render handed its last components. */
	function liveRow() {
		const renderers = bash();
		const args = { command: "npm test" };
		const context = contextFor({ args, isPartial: true });
		context.invalidate = vi.fn();
		let call: any;
		let result: any;
		return {
			context,
			draw(expanded: boolean, isPartial: boolean) {
				Object.assign(context, { expanded, isPartial });
				call = renderers.renderCall?.(args, theme, { ...context, lastComponent: call });
				result = renderers.renderResult?.(text("a") as never, { expanded, isPartial }, theme, {
					...context,
					lastComponent: result,
				});
				return plain([...call.render(120), ...result.render(120)].join("\n"));
			},
		};
	}

	it("times the command from its start, though it was collapsed then", () => {
		vi.useFakeTimers();
		const row = liveRow();
		row.draw(false, true);
		vi.advanceTimersByTime(5000);
		expect(row.draw(true, true)).toContain("Elapsed 5.0s");
	});

	it("stops redrawing once the command ends, though it was collapsed when it did", () => {
		vi.useFakeTimers();
		const row = liveRow();
		row.draw(true, true);
		row.draw(false, false);
		vi.mocked(row.context.invalidate).mockClear();
		vi.advanceTimersByTime(5000);
		expect(row.context.invalidate).not.toHaveBeenCalled();
	});
});

const piGrep = createGrepToolDefinition("/work");
const piFind = createFindToolDefinition("/work");
const piLs = createLsToolDefinition("/work");

describe("collapsed grep, find and ls", () => {
	it("grep is one call line and how many lines matched", () => {
		const out = draw(restyled("grep", piGrep), {
			args: { pattern: "TODO", path: "src" },
			result: text("src/a.ts:3: // TODO one\nsrc/b.ts:9: // TODO two"),
		});
		expect(plain(out)).toBe(`${DOT} Grep(TODO in src)\n  ⎿  Found 2 matches`);
	});

	it("grep counts matches, not the context lines around them or pi's notice", () => {
		const withContext = text(
			"src/a.ts-2- before\nsrc/a.ts:3: // TODO: x:1: y\nsrc/a.ts-4- after\n\n[1 matches limit reached. Use limit=2 for more, or refine pattern]",
			{ matchLimitReached: 1 },
		);
		const out = draw(restyled("grep", piGrep), { args: { pattern: "TODO", context: 1 }, result: withContext });
		expect(plain(out)).toBe(`${DOT} Grep(TODO)\n  ⎿  Found 1 match`);
		const none = draw(restyled("grep", piGrep), { args: { pattern: "nope" }, result: text("No matches found") });
		expect(plain(none)).toContain("⎿  Found 0 matches");
	});

	it("find is one call line and how many files it found", () => {
		const out = draw(restyled("find", piFind), {
			args: { pattern: "**/*.ts", path: "." },
			result: text("a.ts\nsrc/b.ts\nsrc/c.ts\n\n[3 results limit reached]"),
		});
		expect(plain(out)).toBe(`${DOT} Find(**/*.ts)\n  ⎿  3 files`);
		const none = draw(restyled("find", piFind), {
			args: { pattern: "*.rs" },
			result: text("No files found matching pattern"),
		});
		expect(plain(none)).toContain("⎿  0 files");
	});

	it("ls is one call line and how many entries the directory has", () => {
		const out = draw(restyled("ls", piLs), { args: { path: "src" }, result: text("a.ts\nlib/") });
		expect(plain(out)).toBe(`${DOT} Ls(src)\n  ⎿  2 entries`);
		const empty = draw(restyled("ls", piLs), { args: {}, result: text("(empty directory)") });
		expect(plain(empty)).toBe(`${DOT} Ls(.)\n  ⎿  0 entries`);
	});

	it("expanded, each renders exactly as pi renders it", () => {
		const rows: [string, unknown, Row][] = [
			["grep", piGrep, { args: { pattern: "TODO" }, result: text("a.ts:1: TODO"), expanded: true }],
			["find", piFind, { args: { pattern: "*.ts" }, result: text("a.ts"), expanded: true }],
			["ls", piLs, { args: { path: "src" }, result: text("a.ts\nlib/"), expanded: true }],
		];
		for (const [name, pi, row] of rows) expect(draw(restyled(name, pi), row)).toBe(draw(pi as never, row));
	});
});

const piEdit = createEditToolDefinition("/work");
const piWrite = createWriteToolDefinition("/work");
const editArgs = { path: "src/x.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] };
const editDone = text("Successfully replaced 1 block(s) in src/x.ts.", {
	diff: "-1 const a = 1;\n+1 const a = 2;",
	patch: "",
	firstChangedLine: 1,
});

// The test theme writes each colour as a tag, which counts toward the width: a coloured tally needs room on one line.
const WIDE = 200;

describe("collapsed edit and write", () => {
	it("edit is the call line with pi's diff in full under it", () => {
		const out = plain(
			draw(restyled("edit", piEdit), { args: editArgs, result: editDone, argsComplete: false }, WIDE),
		);
		expect(out).toMatch(new RegExp(`^ ${DOT} Edit\\(src/x\\.ts\\) \\(\\+1 -1\\)\n`));
		expect(out).toContain("-1 const a = 1;");
		expect(out).toContain("+1 const a = 2;");
		expect(out).not.toContain("edit src/x.ts");
	});

	it("edit's call line keeps the padding pi's own header had, as edit pads itself", () => {
		const out = plain(
			draw(restyled("edit", piEdit), { args: editArgs, result: editDone, argsComplete: false }, WIDE),
		);
		const diffLine = out.split("\n").find((line) => line.includes("+1 const a = 2;")) ?? "";
		expect(out.split("\n")[0]).toBe(` ${DOT} Edit(src/x.ts) (+1 -1)`);
		expect(diffLine.startsWith(" +1")).toBe(true);
	});

	it("edit shows pi's diff before it runs, while it waits for approval", async () => {
		const dir = mkdtempSync(join(tmpdir(), "transcript-edit-"));
		writeFileSync(join(dir, "x.ts"), "const a = 1;\n");
		const renderers = restyled("edit", createEditToolDefinition(dir));
		const args = { path: "x.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] };
		const context = contextFor({ args, isPartial: true }, dir);
		const previewed = new Promise<void>((resolve) => {
			context.invalidate = resolve;
		});
		const first = renderers.renderCall?.(args, theme, context);
		await previewed;
		const call = renderers.renderCall?.(args, theme, { ...context, lastComponent: first });
		const out = plain(call?.render(120).join("\n") ?? "");
		expect(out.split("\n")[0]?.trimEnd()).toBe(` ${DOT} Edit(x.ts)`);
		expect(out).toContain("+1 const a = 2;");
	});

	it("write is the call line with pi's view of the file under it", () => {
		const row: Row = { args: { path: "notes.md", content: "one\ntwo" }, result: text("Wrote notes.md") };
		expect(plain(draw(restyled("write", piWrite), row))).toBe(`${DOT} Write(notes.md) (+2)\n\none\ntwo`);
	});

	it("edit counts only changed lines, not context or pi's `...` gap", () => {
		const diff = "  1 a\n- 2 b\n- 3 c\n+ 2 B\n  4 d\n    ...\n 40 x\n+41 y";
		const out = plain(
			draw(restyled("edit", piEdit), { args: editArgs, result: text("ok", { diff, patch: "" }) }, WIDE),
		);
		expect(out.split("\n")[0]).toBe(` ${DOT} Edit(src/x.ts) (+2 -2)`);
	});

	it("write does not count the file's trailing newline as a line", () => {
		const row: Row = { args: { path: "notes.md", content: "one\ntwo\n" }, result: text("Wrote notes.md") };
		expect(plain(draw(restyled("write", piWrite), row)).split("\n")[0]).toBe(`${DOT} Write(notes.md) (+2)`);
	});

	it("adds no count until the call succeeded", () => {
		const writing = { path: "notes.md", content: "one" };
		expect(plain(draw(restyled("write", piWrite), { args: writing })).split("\n")[0]).toBe(`${DOT} Write(notes.md)`);
		const failed: Row = { args: editArgs, result: text("Could not find the text", editDone.details), isError: true };
		expect(plain(draw(restyled("edit", piEdit), failed)).split("\n")[0]).toBe(` ${DOT} Edit(src/x.ts)`);
	});

	it("adds no count when the change is empty", () => {
		const row: Row = { args: { path: "empty.md", content: "" }, result: text("Wrote empty.md") };
		expect(plain(draw(restyled("write", piWrite), row)).split("\n")[0]).toBe(`${DOT} Write(empty.md)`);
	});

	it("keeps the count as pi draws the row again", () => {
		const renderers = restyled("edit", piEdit);
		const context = contextFor({ args: editArgs, argsComplete: false });
		let call: any;
		let result: any;
		const pass = (expanded = false) => {
			call = renderers.renderCall?.(editArgs, theme, { ...context, expanded, lastComponent: call });
			result = renderers.renderResult?.(editDone as never, { expanded, isPartial: false }, theme, {
				...context,
				expanded,
				lastComponent: result,
			});
			return plain(call.render(WIDE)[0]).trimEnd();
		};
		expect(pass()).toBe(` ${DOT} Edit(src/x.ts) (+1 -1)`);
		expect(pass()).toBe(` ${DOT} Edit(src/x.ts) (+1 -1)`);
		// Expanding hands the row back to pi; collapsing again builds a new call line.
		pass(true);
		expect(pass()).toBe(` ${DOT} Edit(src/x.ts) (+1 -1)`);
	});

	it("keeps pi's whole view when pi's first lines are not the header it expects", () => {
		// A future pi that draws edit differently: nothing of its body may be cut.
		const piLater = {
			renderCall: () => ({ render: () => ["", "-1 const a = 1;", "+1 const a = 2;", ""], invalidate: () => {} }),
			renderResult: () => ({ render: () => [], invalidate: () => {} }),
		};
		const row: Row = { args: editArgs, result: editDone };
		expect(draw(restyled("edit", piLater), row)).toBe(draw(piLater as never, row));
	});

	it("expanded, each renders exactly as pi renders it", () => {
		const editRow: Row = { args: editArgs, result: editDone, argsComplete: false, expanded: true };
		expect(draw(restyled("edit", piEdit), editRow)).toBe(draw(piEdit as never, editRow));
		const writeRow: Row = { args: { path: "notes.md", content: "one" }, result: text("ok"), expanded: true };
		expect(draw(restyled("write", piWrite), writeRow)).toBe(draw(piWrite as never, writeRow));
	});
});
