import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTranscript, transcriptLines } from "../ext/subagents/inspect.ts";

const entry = (iso: string, message: unknown) => JSON.stringify({ type: "message", timestamp: iso, message });

describe("readTranscript", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("reads message entries, skips other entries and a torn last line, and drops what came before a fork", () => {
		dir = mkdtempSync(join(tmpdir(), "bluclawd-inspect-"));
		const file = join(dir, "c.jsonl");
		writeFileSync(
			file,
			[
				JSON.stringify({ type: "session", id: "x" }),
				entry("2026-09-18T00:00:00.000Z", { role: "user", content: "inherited" }),
				entry("2026-09-18T00:00:10.000Z", { role: "user", content: "Task: mine" }),
				// A message's own timestamp wins over the entry's: inherited, though written late.
				entry("2026-09-18T00:00:20.000Z", {
					role: "user",
					content: "copied",
					timestamp: Date.parse("2026-09-18T00:00:01.000Z"),
				}),
				'{"type":"message","timest',
			].join("\n"),
		);
		expect(readTranscript(file)).toHaveLength(3);
		const own = readTranscript(file, Date.parse("2026-09-18T00:00:05.000Z"));
		expect(own).toEqual([{ role: "user", content: "Task: mine" }]);
	});
});

describe("transcriptLines", () => {
	it("shows text, tool calls with their first string argument, and each result's first line", () => {
		const lines = transcriptLines([
			{ role: "user", content: [{ type: "text", text: "Task: find it" }] },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hidden" },
					{ type: "text", text: "Looking." },
					{ type: "toolCall", name: "grep", arguments: { pattern: "foo", path: "src" } },
				],
			},
			{ role: "toolResult", content: [{ type: "text", text: "\nsrc/a.ts:1: foo\nmore" }] },
			{ role: "toolResult", isError: true, content: [{ type: "text", text: "boom" }] },
		]);
		expect(lines).toEqual([
			{ kind: "user", text: "Task: find it" },
			{ kind: "assistant", text: "Looking." },
			{ kind: "tool", text: "grep(foo)" },
			{ kind: "result", text: "src/a.ts:1: foo" },
			{ kind: "error", text: "boom" },
		]);
	});

	it("keeps only the last lines and flattens long ones", () => {
		const many = Array.from({ length: 10 }, (_, i) => ({ role: "user", content: `m${i} ${"x".repeat(300)}` }));
		const lines = transcriptLines(many, 3, 20);
		expect(lines).toHaveLength(3);
		expect(lines[0].text.startsWith("m7")).toBe(true);
		expect(lines[0].text.length).toBe(21);
	});
});
