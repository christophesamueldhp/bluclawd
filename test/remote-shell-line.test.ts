import { describe, expect, it } from "vitest";
import { shellLine } from "#remote-web/live.js";

const lines: Array<[string, boolean]> = [
	["!ls -la", true],
	["!! git status", true],
	["  !ls", true],
	["!\tls", true],
	["! ls", true],
	["!", false],
	["!   ", false],
	["", false],
	["ls !x", false],
	["/compact", false],
	["hello!", false],
];

describe("a `!` line, as phone control and the phone app read it", () => {
	it.each(lines)("%j is a shell line: %s", (text, expected) => {
		expect(shellLine(text)).toBe(expected);
	});
});
