import { afterEach, describe, expect, it } from "vitest";
import { clearContent, findLines, getContent, listContent, putContent, sliceLines } from "../ext/web/store.ts";

afterEach(() => clearContent());

describe("content store", () => {
	it("hands out kind-prefixed ids and lists newest first", () => {
		const f = putContent("fetch", "https://a/", "page");
		const s = putContent("search", "q", "results");
		expect([f, s]).toEqual(["f1", "s2"]);
		expect(listContent().map((e) => e.id)).toEqual(["s2", "f1"]);
		expect(getContent("f1")?.text).toBe("page");
	});

	it("forgets entries after an hour and beyond 128 entries", () => {
		putContent("fetch", "old", "x", 0);
		expect(getContent("f1", 60 * 60 * 1000)).toBeUndefined();
		for (let i = 0; i < 130; i++) putContent("fetch", `u${i}`, "x");
		expect(listContent().length).toBe(128);
	});

	it("slices by line with a continuation pointer", () => {
		const text = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n");
		expect(sliceLines(text, 3, 2)).toBe("l3\nl4\n\n[lines 3-4 of 10; continue with offset=5]");
		expect(sliceLines(text, 9, 5)).toBe("l9\nl10\n\n[lines 9-10 of 10]");
		expect(sliceLines(text, 11)).toMatch(/past the end/);
	});

	it("finds lines case-insensitively with merged context", () => {
		const text = ["a", "Pricing: $20", "b", "c", "pricing team", "d", "e", "f", "g", "PRICING again"].join("\n");
		expect(findLines(text, ["pricing"], 1)).toBe(
			[
				"1: a",
				"2: Pricing: $20",
				"3: b",
				"4: c",
				"5: pricing team",
				"6: d",
				"...",
				"9: g",
				"10: PRICING again",
			].join("\n"),
		);
		expect(findLines(text, ["nope"])).toMatch(/no line contains "nope"/);
	});
});
