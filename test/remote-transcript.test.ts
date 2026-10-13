// test/remote-transcript.test.ts
import { describe, expect, it } from "vitest";
import { activeBranch, parseEntries, TEXT_MAX, toolSummary, transcriptFrom } from "../daemon/remote/transcript.ts";

const jsonl = (...entries: object[]) => entries.map((entry) => JSON.stringify(entry)).join("\n");
const msg = (id: string, parentId: string | null, message: object) => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-10-12T00:00:00Z",
	message,
});

describe("remote transcript", () => {
	it("reduces each kind of entry to what the phone shows", () => {
		const text = jsonl(
			{ type: "session", version: 3, id: "s", cwd: "/p" },
			{ type: "model_change", id: "m0", parentId: null, provider: "anthropic", modelId: "claude-opus-5-5" },
			msg("u1", "m0", {
				role: "user",
				content: [
					{ type: "text", text: "run the tests" },
					{ type: "image", data: "x", mimeType: "image/png" },
				],
			}),
			msg("a1", "u1", {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "plan" },
					{ type: "text", text: "Running." },
					{
						type: "toolCall",
						id: "c1",
						name: "bash",
						arguments: { command: "npm test", description: "Run tests" },
					},
				],
			}),
			msg("r1", "a1", {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "bash",
				isError: true,
				content: [{ type: "text", text: "1 failed" }],
			}),
			{
				type: "custom_message",
				id: "x1",
				parentId: "r1",
				customType: "note",
				display: true,
				content: "Task done\nmore",
			},
			msg("b1", "x1", { role: "bashExecution", command: "ls", exitCode: 0 }),
			{ type: "compaction", id: "k1", parentId: "b1", summary: "…" },
		);
		expect(transcriptFrom(text, 50)).toEqual([
			{ kind: "marker", id: "m0", text: "Model: anthropic/claude-opus-5-5" },
			{ kind: "user", id: "u1", text: "run the tests\n[Image]" },
			{
				kind: "assistant",
				id: "a1",
				text: "Running.",
				thinking: "plan",
				tools: [{ id: "c1", name: "bash", summary: "npm test" }],
			},
			{
				kind: "toolResult",
				id: "r1",
				toolCallId: "c1",
				toolName: "bash",
				ok: false,
				text: "1 failed",
				truncated: false,
			},
			{ kind: "marker", id: "x1", text: "Task done" },
			{ kind: "marker", id: "b1", text: "!ls" },
			{ kind: "marker", id: "k1", text: "Conversation compacted" },
		]);
	});

	it("follows the branch the file's last entry is on", () => {
		const text = jsonl(
			msg("u1", null, { role: "user", content: "first" }),
			msg("u2", "u1", { role: "user", content: "abandoned" }),
			msg("u3", "u1", { role: "user", content: "kept" }),
		);
		expect(transcriptFrom(text, 50).map((m) => m.id)).toEqual(["u1", "u3"]);
	});

	it("follows the leaf the pane reports, and the last entry when the file lacks it", () => {
		const text = jsonl(
			msg("u1", null, { role: "user", content: "first" }),
			msg("u2", "u1", { role: "user", content: "gone back from" }),
			msg("u3", "u2", { role: "user", content: "more" }),
		);
		expect(transcriptFrom(text, 50, "u1").map((m) => m.id)).toEqual(["u1"]);
		expect(transcriptFrom(text, 50, "zz").map((m) => m.id)).toEqual(["u1", "u2", "u3"]);
	});

	it("skips lines that do not parse, such as a half-written last line", () => {
		const text = `${jsonl(msg("u1", null, { role: "user", content: "hi" }))}\n{"type":"mess`;
		expect(parseEntries(text)).toHaveLength(1);
		expect(transcriptFrom(text, 50)).toHaveLength(1);
	});

	it("truncates a long tool result and keeps only the last `limit` messages", () => {
		const text = jsonl(
			msg("u1", null, { role: "user", content: "a" }),
			msg("r1", "u1", {
				role: "toolResult",
				toolCallId: "c",
				toolName: "read",
				isError: false,
				content: [{ type: "text", text: "x".repeat(TEXT_MAX + 10) }],
			}),
		);
		const messages = transcriptFrom(text, 1);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({ kind: "toolResult", truncated: true });
		expect((messages[0] as { text: string }).text).toHaveLength(TEXT_MAX + 1);
	});

	it("keeps a failed model request and drops an empty assistant message", () => {
		const text = jsonl(
			msg("a1", null, { role: "assistant", content: [], stopReason: "error", errorMessage: "rate limited" }),
			msg("a2", "a1", { role: "assistant", content: [], stopReason: "aborted" }),
		);
		expect(transcriptFrom(text, 50)).toEqual([
			{ kind: "assistant", id: "a1", text: "", tools: [], error: "rate limited" },
		]);
	});

	it("summarises a tool call by its main argument", () => {
		expect(toolSummary({ path: "a.ts", offset: 3 })).toBe("a.ts");
		expect(toolSummary({ command: "echo 1\necho 2" })).toBe("echo 1");
		expect(toolSummary({})).toBe("");
	});

	it("pages back from a message: the last ones before it, none before one not on the branch", () => {
		const text = jsonl(
			msg("u1", null, { role: "user", content: "1" }),
			msg("u2", "u1", { role: "user", content: "2" }),
			msg("u3", "u2", { role: "user", content: "3" }),
			msg("u4", "u3", { role: "user", content: "4" }),
			msg("x9", "u1", { role: "user", content: "another branch" }),
			msg("u5", "u4", { role: "user", content: "5" }),
		);
		expect(transcriptFrom(text, 2, undefined, "u4").map((m) => m.id)).toEqual(["u2", "u3"]);
		expect(transcriptFrom(text, 50, undefined, "u4").map((m) => m.id)).toEqual(["u1", "u2", "u3"]);
		expect(transcriptFrom(text, 50, undefined, "u1")).toEqual([]);
		expect(transcriptFrom(text, 50, undefined, "x9")).toEqual([]);
		expect(transcriptFrom(text, 50, "u3", "u3").map((m) => m.id)).toEqual(["u1", "u2"]);
	});

	it("an empty file has no branch", () => {
		expect(activeBranch([])).toEqual([]);
	});

	it("stops at a parentId cycle instead of looping", () => {
		const text = jsonl(msg("a", "b", { role: "user", content: "a" }), msg("b", "a", { role: "user", content: "b" }));
		expect(transcriptFrom(text, 50).map((m) => m.id)).toEqual(["a", "b"]);
		expect(transcriptFrom(text, 0)).toEqual([]);
	});
});
