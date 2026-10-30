import { describe, expect, it } from "vitest";
import { shellLine as daemonShellLine } from "../daemon/remote/phone-control.ts";
import { shellLine as webShellLine } from "#remote-web/live.js";

// One table for both sides: phone control's rule is the Mac's, and the phone's copy must not drift from it.
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

describe.each([
	["phone control", daemonShellLine],
	["the phone app", webShellLine],
])("a `!` line, as %s reads it", (_, shellLine) => {
	it.each(lines)("%j is a shell line: %s", (text, expected) => {
		expect(shellLine(text)).toBe(expected);
	});
});
