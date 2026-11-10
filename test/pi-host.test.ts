import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PI_HOST, piHost } from "./helpers/pi-host.ts";
import { hasTmux, type RealPi, startRealPi } from "./helpers/real-pi.ts";

const REQUIRED = (
	JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
		devDependencies: Record<string, string>;
	}
).devDependencies["@earendil-works/pi-coding-agent"];

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A host installed in a fresh tree: pi-coding-agent at `version` and each sibling at its own version. */
function fakeHost(version: string, siblings: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "bc-pi-host-"));
	tempDirs.push(root);
	const write = (name: string, manifest: object) => {
		const dir = join(root, "node_modules", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name, ...manifest }));
		return dir;
	};
	for (const [name, siblingVersion] of Object.entries(siblings)) write(name, { version: siblingVersion });
	return write("@earendil-works/pi-coding-agent", { version, dependencies: siblings });
}

describe("the pi host", () => {
	it("is the required published pi, with every sibling package at the same version", () => {
		expect(REQUIRED).toBe("1.5.2");
		expect(PI_HOST.version).toBe(REQUIRED);
		expect(Object.keys(PI_HOST.siblings)).toEqual(
			expect.arrayContaining(["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-tui"]),
		);
		for (const version of Object.values(PI_HOST.siblings)) expect(version).toBe(REQUIRED);
	});

	it("is refused when a sibling it resolves is another version", () => {
		const host = fakeHost("1.5.2", { "@earendil-works/pi-ai": "1.0.4", "@earendil-works/pi-tui": "1.5.2" });
		expect(() => piHost(host)).toThrow(/@earendil-works\/pi-ai 1\.0\.4/);
	});

	it("is refused when a sibling it depends on is missing", () => {
		const host = fakeHost("1.5.2", { "@earendil-works/pi-tui": "1.5.2" });
		const manifest = join(host, "package.json");
		const parsed = JSON.parse(readFileSync(manifest, "utf8"));
		parsed.dependencies["@earendil-works/pi-ai"] = "1.5.2";
		writeFileSync(manifest, JSON.stringify(parsed));
		expect(() => piHost(host)).toThrow(/@earendil-works\/pi-ai/);
	});

	it("is accepted when every sibling matches", () => {
		const host = fakeHost("1.5.2", { "@earendil-works/pi-ai": "1.5.2", "@earendil-works/pi-tui": "1.5.2" });
		expect(piHost(host)).toEqual({
			version: "1.5.2",
			siblings: { "@earendil-works/pi-ai": "1.5.2", "@earendil-works/pi-tui": "1.5.2" },
		});
	});
});

describe.skipIf(!hasTmux)("a real pi pane", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	it("runs the required pi, as the model it asks sees it", async () => {
		pi = await startRealPi();
		pi.script("main", [{ text: "done" }]);
		pi.start(["--", "hello"]);
		const [request] = await pi.waitForRequests("main", 1);
		expect(request.host).toBe(REQUIRED);
	});
});
