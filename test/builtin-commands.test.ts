/**
 * The vendored copy of pi's built-in slash commands, checked against the pi installed here.
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../ext/_shared/builtin-commands.ts";

describe("BUILTIN_SLASH_COMMANDS", () => {
	it("matches pi's own list", async () => {
		const pi = await import(
			new URL("core/slash-commands.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
		);
		expect(BUILTIN_SLASH_COMMANDS).toEqual(pi.BUILTIN_SLASH_COMMANDS);
	});
});
