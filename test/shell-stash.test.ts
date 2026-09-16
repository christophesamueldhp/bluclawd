import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StashHistory, stashAction } from "../ext/shell/stash.ts";

describe("stashAction", () => {
	it("follows the four editor/stash combinations", () => {
		expect(stashAction("draft", undefined)).toBe("stash");
		expect(stashAction("", "saved")).toBe("restore");
		expect(stashAction("new draft", "saved")).toBe("update");
		expect(stashAction("  \n ", undefined)).toBe("nothing");
	});
});

describe("StashHistory", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "stash-history-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("keeps newest first, skips a repeat of the newest, and survives a reload", () => {
		const path = join(dir, "nested", "stash-history.json");
		const history = new StashHistory(path, 3);
		history.add("one");
		history.add("two");
		history.add("two");
		history.add("   ");
		expect(history.entries).toEqual(["two", "one"]);

		expect(new StashHistory(path, 3).entries).toEqual(["two", "one"]);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ history: ["two", "one"] });
	});

	it("caps the list at its limit", () => {
		const history = new StashHistory(join(dir, "h.json"), 2);
		for (const text of ["a", "b", "c"]) history.add(text);
		expect(history.entries).toEqual(["c", "b"]);
	});

	it("starts empty from a missing or malformed file", () => {
		expect(new StashHistory(join(dir, "missing.json")).entries).toEqual([]);
		mkdirSync(join(dir, "bad"));
		writeFileSync(join(dir, "bad", "h.json"), "{not json");
		expect(new StashHistory(join(dir, "bad", "h.json")).entries).toEqual([]);
		writeFileSync(join(dir, "h2.json"), JSON.stringify({ history: ["ok", 5, "", "ok2"] }));
		expect(new StashHistory(join(dir, "h2.json")).entries).toEqual(["ok", "ok2"]);
	});
});
