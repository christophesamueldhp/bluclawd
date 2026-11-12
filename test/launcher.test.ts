import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("bin.mjs", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "bluclawd-launcher-"));
	});
	afterEach(() => rmSync(cwd, { recursive: true, force: true }));

	/** The arguments the launcher hands pi's `main`, run from a directory with no pi settings. */
	const argsGivenToPi = (args: string[]) =>
		JSON.parse(
			execFileSync(
				process.execPath,
				["--import", resolve("test/fixtures/launcher/stub-pi-hook.mjs"), resolve("bin.mjs"), ...args],
				{ cwd, encoding: "utf8" },
			),
		);

	it("passes pi the arguments it was given, leaving the TUI mode to pi and its settings", () => {
		expect(argsGivenToPi(["--model", "faux-1", "hello"])).toEqual(["--model", "faux-1", "hello"]);
	});
});
