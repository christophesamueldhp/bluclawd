/**
 * The pieces of pi this package copies or reaches into, checked against the pi installed here, so
 * a pi version bump that changes them fails here instead of drifting silently.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { stripAnsi } from "../daemon/ansi.ts";
import { resolveToCwd } from "../ext/_shared/path-resolve.ts";
import { editorSupportsPasteTokens } from "../ext/paste/index.ts";

const piModule = (path: string) => import(new URL(path, import.meta.resolve("@earendil-works/pi-coding-agent")).href);

describe("vendored from pi", () => {
	it("resolveToCwd resolves every path as pi's tools do (deny rules match on it)", async () => {
		const pi = await piModule("core/tools/path-utils.js");
		const cwd = "/proj/sub";
		const inputs = [
			"a.ts",
			"./a.ts",
			"../a.ts",
			"/etc/hosts",
			"//etc/hosts",
			"~",
			"~/x",
			`${homedir()}/x`,
			"@a.ts",
			"a b.ts",
			"file:///tmp/x",
			"src/../../x",
			" a.ts ",
			"",
			".",
		];
		for (const input of inputs) expect(resolveToCwd(input, cwd), input).toBe(pi.resolveToCwd(input, cwd));
	});

	it("stripAnsi strips what pi's does", async () => {
		const pi = await piModule("utils/ansi.js");
		const inputs = [
			"plain",
			"\x1b[31mred\x1b[0m",
			"\x1b[38;2;255;193;7mamber\x1b[39m",
			"\x1b]8;;https://x.dev\x07link\x1b]8;;\x07",
			"\x1b]777;notify;t;b\x07after",
			"a\x1b[2Kb\x1b[1A",
		];
		for (const input of inputs) expect(stripAnsi(input), JSON.stringify(input)).toBe(pi.stripAnsi(input));
	});

	it("pi's own settings use none of the top-level keys bluclawd adds (ext/_shared/settings.ts)", () => {
		const types = readFileSync(
			new URL("core/settings-manager.d.ts", import.meta.resolve("@earendil-works/pi-coding-agent")),
			"utf8",
		);
		const body = types.match(/export interface Settings \{([\s\S]*?)\n\}/)?.[1] ?? "";
		const keys = [...body.matchAll(/^ {4}(\w+)\??:/gm)].map((match) => match[1]);
		expect(keys.length).toBeGreaterThan(10);
		for (const key of ["permissions", "remote", "prefersReducedMotion"]) expect(keys).not.toContain(key);
	});

	it("pi-tui's Editor still has every internal the paste extension patches", () => {
		expect(editorSupportsPasteTokens()).toBe(true);
	});
});
