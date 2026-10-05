import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readViewHistory, reconcileEntryIds } from "../daemon/view-history.ts";
import { assistant } from "./support/view-fixtures.ts";

let dir: string;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});
function file(entries: unknown[]) {
	dir = mkdtempSync(join(tmpdir(), "view-history-"));
	const path = join(dir, "session.jsonl");
	writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
	return path;
}
function message(id: string, parentId: string | null, text: string) {
	return { type: "message", id, parentId, timestamp: "2026-10-05T00:00:00Z", message: assistant(text) };
}
describe("read-only display history", () => {
	it("preserves identical messages at equal timestamps", () => {
		const p = file([message("first", null, "same"), message("second", "first", "same")]);
		expect(readViewHistory(p).messages.map((m) => m.entryId)).toEqual(["first", "second"]);
	});
	it("walks active branch and keeps precompaction display history", () => {
		const p = file([
			message("a", null, "before"),
			message("abandoned", "a", "wrong"),
			{
				type: "compaction",
				id: "summary",
				parentId: "a",
				summary: "summary",
				tokensBefore: 42,
				firstKeptEntryId: "a",
				timestamp: "2026-10-05T00:00:00Z",
			},
			message("last", "summary", "after"),
		]);
		const before = readFileSync(p, "utf8");
		const result = readViewHistory(p);
		expect(result.messages.map((m) => m.entryId)).toEqual(["a", "summary", "last"]);
		expect(readFileSync(p, "utf8")).toBe(before);
	});
	it("ignores only unfinished trailing records", () => {
		const p = file([message("a", null, "saved")]);
		writeFileSync(p, readFileSync(p, "utf8") + '{"type":');
		expect(readViewHistory(p).messages).toHaveLength(1);
	});
	it("pages at most 200 entries with a stable cursor", () => {
		const p = file(Array.from({ length: 201 }, (_, i) => message(String(i), i ? String(i - 1) : null, String(i))));
		const first = readViewHistory(p, undefined, 900);
		expect(first.messages).toHaveLength(200);
		expect(first.before).toBe("1");
		expect(readViewHistory(p, first.before).messages.map((m) => m.entryId)).toEqual(["0"]);
		expect(() => readViewHistory(p, "missing")).toThrow("cursor");
	});
	it("reports missing files", () => {
		expect(() => readViewHistory("/does/not/exist.jsonl")).toThrow();
	});
	it("reconciles occurrences without collapsing identical messages", () => {
		const persisted = [
			{ key: "first", entryId: "first", message: assistant("same") },
			{ key: "second", entryId: "second", message: assistant("same") },
		];
		const r = reconcileEntryIds(
			[
				{ key: "live:1", message: assistant("same") },
				{ key: "live:2", message: assistant("same") },
			],
			persisted,
		);
		expect(r.map((m) => m.entryId)).toEqual(["first", "second"]);
		expect(r.map((m) => m.key)).toEqual(["live:1", "live:2"]);
	});
});
