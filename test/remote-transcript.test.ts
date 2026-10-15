// test/remote-transcript.test.ts
import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	activeBranch,
	DIFF_MAX,
	imageFrom,
	loadImage,
	loadOutput,
	loadTranscript,
	OUTPUT_MAX,
	parseEntries,
	TEXT_MAX,
	toolSummary,
	transcriptFrom,
} from "../daemon/remote/transcript.ts";
import { promptKey } from "../daemon/remote/web/live.js";

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
			{ kind: "user", id: "u1", text: "run the tests\n[Image]", images: [{ index: 0, mimeType: "image/png" }] },
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
			msg("a2", "a1", { role: "assistant", content: [], stopReason: "stop" }),
		);
		expect(transcriptFrom(text, 50)).toEqual([
			{ kind: "assistant", id: "a1", text: "", tools: [], error: "rate limited" },
		]);
	});

	it("marks a turn the user stopped, before any reply, mid-reply and during a tool", () => {
		// As pi writes them: the provider's abort, and the run's own when it was stopped before a request.
		const aborted = (id: string, parentId: string, content: object[]) =>
			msg(id, parentId, {
				role: "assistant",
				content,
				stopReason: "aborted",
				errorMessage: "Request was aborted",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			});
		const text = jsonl(
			msg("u1", null, { role: "user", content: "go" }),
			aborted("a1", "u1", [{ type: "text", text: "" }]),
			msg("u2", "a1", { role: "user", content: "again" }),
			aborted("a2", "u2", [{ type: "text", text: "Half a repl" }]),
			msg("u3", "a2", { role: "user", content: "run it" }),
			msg("a3", "u3", {
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "sleep 60" } }],
				stopReason: "toolUse",
			}),
			msg("r1", "a3", {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "bash",
				isError: true,
				content: [{ type: "text", text: "Command aborted" }],
			}),
			aborted("a4", "r1", []),
		);
		expect(transcriptFrom(text, 50).filter((m) => m.kind === "assistant")).toEqual([
			{ kind: "assistant", id: "a1", text: "", tools: [], aborted: true },
			{ kind: "assistant", id: "a2", text: "Half a repl", tools: [], aborted: true },
			{ kind: "assistant", id: "a3", text: "", tools: [{ id: "c1", name: "bash", summary: "sleep 60" }] },
			{ kind: "assistant", id: "a4", text: "", tools: [], aborted: true },
		]);
	});

	it("hides model and thinking level changes, as Claude Code's transcript does", () => {
		const text = jsonl(
			{ type: "model_change", id: "m0", parentId: null, provider: "anthropic", modelId: "claude-opus-5-5" },
			{ type: "thinking_level_change", id: "t0", parentId: "m0", thinkingLevel: "high" },
			msg("u1", "t0", { role: "user", content: "hi" }),
			{ type: "model_change", id: "m1", parentId: "u1", provider: "openai", modelId: "gpt-5" },
			{ type: "session_info", id: "n1", parentId: "m1", name: "renamed" },
		);
		expect(transcriptFrom(text, 50)).toEqual([{ kind: "user", id: "u1", text: "hi" }]);
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

	describe("images", () => {
		const png = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
		const jpeg = { type: "image", data: "/9j/4AAQ", mimeType: "image/jpeg" };
		const text = jsonl(
			msg("u1", null, { role: "user", content: [{ type: "text", text: "look" }, png, jpeg] }),
			msg("a1", "u1", {
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/p/a.png" } }],
			}),
			msg("r1", "a1", {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "read",
				content: [{ type: "text", text: "Read image file [image/png]" }, png],
			}),
			msg("u2", "r1", { role: "user", content: "no picture" }),
			msg("u3", "u1", { role: "user", content: [{ type: "text", text: "elsewhere" }, png] }),
		);

		it("are referenced by position and type, without their data, and still an [Image] line", () => {
			const messages = transcriptFrom(text, 50, "u2");
			expect(messages.find((m) => m.id === "u1")).toEqual({
				kind: "user",
				id: "u1",
				text: "look\n[Image]\n[Image]",
				images: [
					{ index: 0, mimeType: "image/png" },
					{ index: 1, mimeType: "image/jpeg" },
				],
			});
			expect(messages.find((m) => m.id === "r1")).toMatchObject({
				text: "Read image file [image/png]\n[Image]",
				images: [{ index: 0, mimeType: "image/png" }],
			});
			// What the phone matches its pending prompt by.
			expect(messages.find((m) => m.id === "u1")?.text).toBe(promptKey("look", 2));
			expect(messages.find((m) => m.id === "u2")).toEqual({ kind: "user", id: "u2", text: "no picture" });
			expect(JSON.stringify(messages)).not.toContain("iVBORw0KGgo");
		});

		it("are found by entry and position on the active branch only", () => {
			expect(imageFrom(text, "u1", 1, "u2")).toEqual({ mimeType: "image/jpeg", data: "/9j/4AAQ" });
			expect(imageFrom(text, "r1", 0, "u2")).toEqual({ mimeType: "image/png", data: "iVBORw0KGgo=" });
			expect(imageFrom(text, "u1", 2, "u2")).toBeUndefined();
			expect(imageFrom(text, "u2", 0, "u2")).toBeUndefined();
			expect(imageFrom(text, "a1", 0, "u2")).toBeUndefined();
			expect(imageFrom(text, "nope", 0, "u2")).toBeUndefined();
			// The other branch, which the pane is not on.
			expect(imageFrom(text, "u3", 0, "u2")).toBeUndefined();
			expect(imageFrom(text, "u3", 0)).toEqual({ mimeType: "image/png", data: "iVBORw0KGgo=" });
		});
	});

	it("an empty file has no branch", () => {
		expect(activeBranch([])).toEqual([]);
	});

	it("stops at a parentId cycle instead of looping", () => {
		const text = jsonl(msg("a", "b", { role: "user", content: "a" }), msg("b", "a", { role: "user", content: "b" }));
		expect(transcriptFrom(text, 50).map((m) => m.id)).toEqual(["a", "b"]);
		expect(transcriptFrom(text, 0)).toEqual([]);
	});

	it("keeps an edit's diff, cut to 16 KB, and none for a result without one", () => {
		const edit = (id: string, diff: unknown) =>
			msg(id, null, {
				role: "toolResult",
				toolCallId: "c",
				toolName: "edit",
				content: [{ type: "text", text: "Successfully replaced 1 block(s) in a.ts." }],
				details: { diff },
			});
		const diff = "- old\n+ new";
		expect(transcriptFrom(jsonl(edit("r1", diff)), 50)[0]).toMatchObject({
			text: "Successfully replaced 1 block(s) in a.ts.",
			diff,
			diffTruncated: false,
		});
		const long = transcriptFrom(jsonl(edit("r1", "+".repeat(DIFF_MAX + 5))), 50)[0] as { diff: string };
		expect(long).toMatchObject({ diffTruncated: true });
		expect(long.diff).toHaveLength(DIFF_MAX + 1);
		for (const none of [undefined, "", 42]) {
			expect(transcriptFrom(jsonl(edit("r1", none)), 50)[0]).not.toHaveProperty("diff");
		}
	});

	describe("reading the file", () => {
		let dir: string;
		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "bluclawd-transcript-"));
		});
		afterEach(() => rmSync(dir, { recursive: true, force: true }));
		const user = (id: string, parentId: string | null, content: string) =>
			`${JSON.stringify(msg(id, parentId, { role: "user", content }))}\n`;
		const at = new Date("2026-10-15T10:00:00Z");

		it("parses a file again only once its size or mtime changes", () => {
			const file = join(dir, "s.jsonl");
			writeFileSync(file, user("u1", null, "aaaa"));
			utimesSync(file, at, at);
			expect(loadTranscript(file, 50)).toMatchObject([{ id: "u1", text: "aaaa" }]);
			// Same size and mtime: the entries parsed before.
			writeFileSync(file, user("u1", null, "bbbb"));
			utimesSync(file, at, at);
			expect(loadTranscript(file, 50)).toMatchObject([{ id: "u1", text: "aaaa" }]);
			// An entry appended: parsed again, for every reader.
			appendFileSync(file, user("u2", "u1", "more"));
			expect(loadTranscript(file, 50).map((m) => [m.id, m.text])).toEqual([
				["u1", "bbbb"],
				["u2", "more"],
			]);
			expect(loadImage(file, "u2", 0)).toBeUndefined();
		});

		it("keeps the eight files read last", () => {
			const files = Array.from({ length: 9 }, (_, i) => join(dir, `s${i}.jsonl`));
			for (const file of files) {
				writeFileSync(file, user("u1", null, "aaaa"));
				utimesSync(file, at, at);
				loadTranscript(file, 50);
			}
			for (const file of files) {
				writeFileSync(file, user("u1", null, "bbbb"));
				utimesSync(file, at, at);
			}
			// The first was dropped for the ninth; reading it drops the second.
			expect(loadTranscript(files[0], 50)[0]).toMatchObject({ text: "bbbb" });
			expect(loadTranscript(files[2], 50)[0]).toMatchObject({ text: "aaaa" });
			expect(loadTranscript(files[1], 50)[0]).toMatchObject({ text: "bbbb" });
		});

		it("gives a tool result's whole output, up to 256 KB, on the active branch only", () => {
			const file = join(dir, "s.jsonl");
			const result = (id: string, parentId: string, text: string) =>
				`${JSON.stringify(msg(id, parentId, { role: "toolResult", toolCallId: "c", toolName: "bash", content: [{ type: "text", text }] }))}\n`;
			writeFileSync(
				file,
				user("u1", null, "go") +
					result("r1", "u1", "x".repeat(TEXT_MAX * 2)) +
					result("r2", "r1", "y".repeat(OUTPUT_MAX + 3)) +
					user("u9", "u1", "elsewhere"),
			);
			expect(loadOutput(file, "r1", "r2")).toEqual({ text: "x".repeat(TEXT_MAX * 2), truncated: false });
			expect(loadOutput(file, "r2", "r2")).toEqual({ text: `${"y".repeat(OUTPUT_MAX)}…`, truncated: true });
			expect(loadOutput(file, "u1", "r2")).toBeUndefined();
			expect(loadOutput(file, "r1")).toBeUndefined();
			expect(loadOutput(join(dir, "missing.jsonl"), "r1")).toBeUndefined();
			expect(loadOutput(undefined, "r1")).toBeUndefined();
		});
	});
});
