import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newestMtimeMs } from "../daemon/config.ts";

/**
 * The build identifier must reflect a rebuild that only touches a NESTED file
 * (e.g. handler.ts, not the entry cli.ts) — dist/ is tsgo output, one .js per
 * source file, not a bundle, so stat'ing only the entry file would miss the
 * common case of editing anything else and rebuilding.
 */
describe("newestMtimeMs", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "bluclawd-newest-mtime-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("reflects a change to a file nested in a subdirectory, not just the top level", async () => {
		mkdirSync(join(tempDir, "ipc"), { recursive: true });
		writeFileSync(join(tempDir, "cli.js"), "// entry");
		writeFileSync(join(tempDir, "ipc", "server.js"), "// v1");

		const before = newestMtimeMs(tempDir);

		// Ensure a distinct mtime tick, then touch only the NESTED file — mirrors "rebuilt
		// handler.ts, cli.ts's own output was untouched."
		await new Promise((resolve) => setTimeout(resolve, 10));
		writeFileSync(join(tempDir, "ipc", "server.js"), "// v2");

		const after = newestMtimeMs(tempDir);
		expect(after).toBeGreaterThan(before);
	});

	it("returns 0 for a directory with no files", () => {
		expect(newestMtimeMs(tempDir)).toBe(0);
	});

	it("returns 0 for a directory that does not exist (never throws)", () => {
		expect(newestMtimeMs(join(tempDir, "absent"))).toBe(0);
	});
});
