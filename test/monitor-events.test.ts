import { describe, expect, it } from "vitest";
import { splitLines } from "../ext/_shared/lines.ts";

describe("splitLines", () => {
	it("returns whole lines and carries the partial tail", () => {
		expect(splitLines("", "a\nb\nc")).toEqual({ lines: ["a", "b"], carry: "c" });
	});

	it("prepends the previous carry to the next chunk", () => {
		expect(splitLines("c", "d\n")).toEqual({ lines: ["cd"], carry: "" });
	});

	it("strips a trailing carriage return", () => {
		expect(splitLines("", "a\r\nb\r\n")).toEqual({ lines: ["a", "b"], carry: "" });
	});

	it("drops empty lines", () => {
		expect(splitLines("", "\n\na\n\n")).toEqual({ lines: ["a"], carry: "" });
	});
});
