import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installedPiHost, piHost } from "./helpers/pi-host.ts";
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

/** One installed package: its version and the packages it depends on. */
type FakePackage = { version: string; dependencies?: string[] };

/** A fresh tree of `@earendil-works/*` packages, pi-coding-agent among them; returns pi-coding-agent's directory. */
function fakeHost(packages: Record<string, FakePackage>): string {
	const root = mkdtempSync(join(tmpdir(), "bc-pi-host-"));
	tempDirs.push(root);
	for (const [name, { version, dependencies = [] }] of Object.entries(packages)) {
		const dir = join(root, "node_modules", "@earendil-works", name);
		mkdirSync(dir, { recursive: true });
		const deps = Object.fromEntries(dependencies.map((dep) => [`@earendil-works/${dep}`, version]));
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ name: `@earendil-works/${name}`, version, dependencies: deps }),
		);
	}
	return join(root, "node_modules", "@earendil-works", "pi-coding-agent");
}

const AGENT = { version: "1.5.2", dependencies: ["pi-ai", "pi-tui"] };

describe("the pi host", () => {
	it("is the required published pi, with every sibling package at the same version", () => {
		expect(REQUIRED).toBe("1.5.2");
		const host = installedPiHost();
		expect(host.version).toBe(REQUIRED);
		expect(Object.keys(host.siblings)).toEqual(
			expect.arrayContaining([
				"@earendil-works/pi-agent-core",
				"@earendil-works/pi-ai",
				"@earendil-works/pi-schema",
				"@earendil-works/pi-tui",
			]),
		);
		for (const version of Object.values(host.siblings)) expect(version).toBe(REQUIRED);
	});

	it("is refused when a sibling it resolves is another version", () => {
		const host = fakeHost({
			"pi-coding-agent": AGENT,
			"pi-ai": { version: "1.0.4" },
			"pi-tui": { version: "1.5.2" },
		});
		expect(() => piHost(host)).toThrow(/@earendil-works\/pi-ai 1\.0\.4/);
	});

	it("is refused when a package a sibling depends on is another version", () => {
		const host = fakeHost({
			"pi-coding-agent": AGENT,
			"pi-ai": { version: "1.5.2", dependencies: ["pi-schema"] },
			"pi-tui": { version: "1.5.2" },
			"pi-schema": { version: "1.5.0" },
		});
		expect(() => piHost(host)).toThrow(/@earendil-works\/pi-schema 1\.5\.0/);
	});

	it("is refused when a sibling it depends on is missing", () => {
		const host = fakeHost({ "pi-coding-agent": AGENT, "pi-tui": { version: "1.5.2" } });
		expect(() => piHost(host)).toThrow(/@earendil-works\/pi-ai missing/);
	});

	it("is accepted when every package matches", () => {
		const host = fakeHost({
			"pi-coding-agent": AGENT,
			"pi-ai": { version: "1.5.2", dependencies: ["pi-schema"] },
			"pi-tui": { version: "1.5.2" },
			"pi-schema": { version: "1.5.2" },
		});
		expect(piHost(host)).toEqual({
			version: "1.5.2",
			siblings: {
				"@earendil-works/pi-ai": "1.5.2",
				"@earendil-works/pi-tui": "1.5.2",
				"@earendil-works/pi-schema": "1.5.2",
			},
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
		expect(request.piVersion).toBe(REQUIRED);
	});
});
