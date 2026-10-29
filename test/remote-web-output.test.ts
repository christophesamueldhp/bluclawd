import { describe, expect, it } from "vitest";
import { diffSummary, groupSummary, markerKind, resultSummary } from "#remote-web/output.js";

const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");

describe("a tool result's line under its call", () => {
	it("counts what a read read", () => {
		expect(resultSummary("read", { text: numbered(120) })).toEqual(["Read 120 lines"]);
		expect(resultSummary("read", { text: "one" })).toEqual(["Read 1 line"]);
		// pi's note says how much was shown, where the text alone would count its note too.
		expect(
			resultSummary("read", { text: `${numbered(50)}\n\n[Showing lines 1-50 of 900. Use offset=51 to continue.]` }),
		).toEqual(["Read 50 lines"]);
		expect(
			resultSummary("read", { text: `${numbered(10)}\n\n[890 more lines in file. Use offset=11 to continue.]` }),
		).toEqual(["Read 10 lines"]);
		// The Mac cut the text short: there are at least as many lines.
		expect(resultSummary("read", { text: numbered(40), truncated: true })).toEqual(["Read 40+ lines"]);
	});

	it("says what a write or an edit without a diff did, without pi's 'Successfully'", () => {
		expect(resultSummary("write", { text: "Successfully wrote to src/x.ts" })).toEqual(["Wrote to src/x.ts"]);
		expect(resultSummary("edit", { text: "Successfully replaced 1 block(s) in a.ts." })).toEqual([
			"Replaced 1 block(s) in a.ts.",
		]);
	});

	it("shows a shell's first lines, then how many more", () => {
		expect(resultSummary("bash", { text: "ok" })).toEqual(["ok"]);
		expect(resultSummary("bash", { text: numbered(3) })).toEqual(["line 1", "line 2", "line 3"]);
		expect(resultSummary("bash", { text: numbered(10) })).toEqual(["line 1", "line 2", "line 3", "… +7 lines"]);
		expect(resultSummary("bash", { text: numbered(4) })).toEqual(["line 1", "line 2", "line 3", "… +1 line"]);
		expect(resultSummary("bash", { text: numbered(10), truncated: true })).toEqual([
			"line 1",
			"line 2",
			"line 3",
			"… +7+ lines",
		]);
		expect(resultSummary("bash", { text: "x".repeat(3000), truncated: true })).toEqual(["x".repeat(3000), "…"]);
		expect(resultSummary("bash", { text: "" })).toEqual(["(No output)"]);
		expect(resultSummary("bash", { text: "\n\n" })).toEqual(["(No output)"]);
	});

	it("counts a search's matches and files, and a listing's paths", () => {
		expect(resultSummary("grep", { text: "a.ts:3: foo\na.ts-4- bar\nb.ts:9: foo" })).toEqual(["Found 2 matches"]);
		expect(resultSummary("grep", { text: "a.ts:3: foo" })).toEqual(["Found 1 match"]);
		expect(resultSummary("grep", { text: "No matches found" })).toEqual(["No matches found"]);
		expect(resultSummary("find", { text: "a.ts\nb.ts\nc.ts" })).toEqual(["Found 3 files"]);
		expect(resultSummary("ls", { text: "a/\nb.ts" })).toEqual(["Listed 2 paths"]);
	});

	it("shows an error's own first lines, without the blank ones", () => {
		expect(resultSummary("bash", { ok: false, text: "boom\n\nCommand exited with code 1" })).toEqual([
			"boom",
			"Command exited with code 1",
		]);
		expect(resultSummary("bash", { ok: false, text: "a\n\nb\n\nc\n\nd\ne" })).toEqual(["a", "b", "c", "… +2 lines"]);
		expect(resultSummary("read", { ok: false, text: "ENOENT: no such file" })).toEqual(["ENOENT: no such file"]);
		expect(resultSummary("read", { ok: false, text: "" })).toEqual(["Error"]);
	});

	it("shows any other tool's first lines", () => {
		expect(resultSummary("web_search", { text: "Result one\nResult two" })).toEqual(["Result one", "Result two"]);
		expect(resultSummary("Mystery", { text: numbered(5) })).toEqual(["line 1", "line 2", "line 3", "… +2 lines"]);
	});

	it("words an edit's diff", () => {
		expect(diffSummary(3, 1)).toBe("Added 3 lines, removed 1 line");
		expect(diffSummary(1, 0)).toBe("Added 1 line");
		expect(diffSummary(0, 2)).toBe("Removed 2 lines");
		expect(diffSummary(0, 0)).toBe("No changes");
	});
});

describe("how a marker shows", () => {
	it("shows an interrupted turn as such", () => {
		expect(markerKind("Interrupted", false)).toBe("interrupted");
		expect(markerKind("Interrupted by user", false)).toBe("interrupted");
		expect(markerKind("aborted", true)).toBe("interrupted");
	});

	it("hides the model a session starts with, and an empty one; shows a later switch", () => {
		expect(markerKind("Model: anthropic/claude-opus", true)).toBe("hidden");
		expect(markerKind("Model: anthropic/claude-opus", false)).toBe("plain");
		expect(markerKind("  ", false)).toBe("hidden");
	});

	it("shows the rest as they are", () => {
		expect(markerKind("Conversation compacted", false)).toBe("plain");
		expect(markerKind("!npm test", true)).toBe("plain");
	});
});

describe("a run of tool calls, folded into one line", () => {
	it("says what the calls did, in the order they first came", () => {
		expect(groupSummary(["bash", "bash"])).toBe("Ran 2 commands");
		expect(groupSummary(["read", "bash", "edit", "bash"])).toBe("Read a file, ran 2 commands, edited a file");
		expect(groupSummary(["write", "grep", "find", "ls"])).toBe("Wrote a file, searched 2 times, listed a folder");
		expect(groupSummary(["PowerShell", "subagent", "subagent"])).toBe("Ran a command, used 2 tools");
	});
});
