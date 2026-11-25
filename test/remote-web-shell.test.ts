import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_DIR = join(import.meta.dirname, "../daemon/remote/web");

describe("the app's modules", () => {
	const imported = (file: string) =>
		[...readFileSync(join(WEB_DIR, file), "utf8").matchAll(/from "\.\/([\w.-]+\.js)"/g)].map((m) => m[1]);

	it("are all in the offline shell", () => {
		const modules = new Set(imported("app.js").flatMap((name) => [name, ...imported(name)]));
		expect(modules).toContain("markdown.js");
		const sw = readFileSync(join(WEB_DIR, "sw.js"), "utf8");
		for (const name of modules) expect(sw).toContain(`"/${name}"`);
	});

	it("show the version the offline shell caches, 0.0.N", () => {
		const version = (file: string) =>
			/const VERSION = "([^"]+)";/.exec(readFileSync(join(WEB_DIR, file), "utf8"))?.[1];
		expect(version("sw.js")).toMatch(/^0\.0\.\d+$/);
		expect(version("app.js")).toBe(version("sw.js"));
	});
});
