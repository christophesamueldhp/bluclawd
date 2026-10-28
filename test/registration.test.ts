import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bluclawdExtensions } from "../ext/index.ts";
import { recordExtensions } from "../scripts/probe-extensions.ts";

/**
 * Turns `probe-extensions.ts`'s printed table into an assertion. This is the
 * check to run after every pi version bump: an upstream rename
 * that breaks a factory at registration time typechecks fine (the type it
 * changed may still structurally match) and only throws here.
 */
const EXPECTED: Record<string, { commands: string[]; tools: string[]; shortcuts: number; events: number }> = {
	permissions: { commands: [], tools: [], shortcuts: 1, events: 3 },
	sandbox: { commands: ["sandbox"], tools: [], shortcuts: 0, events: 3 },
	checkpoints: { commands: ["rewind"], tools: [], shortcuts: 0, events: 6 },
	"background-bash": {
		commands: ["tasks"],
		tools: ["bash", "monitor", "task_stop"],
		shortcuts: 0,
		events: 3,
	},
	subagents: {
		commands: [],
		tools: ["subagent_message", "subagent_models", "subagent_status", "subagent_stop", "subagent"],
		shortcuts: 0,
		events: 8,
	},
	branding: { commands: ["theme"], tools: [], shortcuts: 0, events: 2 },
	"agent-view": {
		commands: ["agent-view"],
		tools: [],
		shortcuts: 0,
		events: 9,
	},
	remote: { commands: ["remote-control"], tools: [], shortcuts: 0, events: 11 },
	help: { commands: ["help", "context", "status"], tools: [], shortcuts: 0, events: 0 },
	vibes: { commands: [], tools: [], shortcuts: 0, events: 2 },
	paste: { commands: [], tools: [], shortcuts: 0, events: 2 },
	"prompt-assist": { commands: ["prompt-assist"], tools: [], shortcuts: 0, events: 6 },
};

describe("bluclawd extension registration", () => {
	const rec = recordExtensions();

	it("registers exactly the 12 expected extensions, no more, no fewer", () => {
		expect(Object.keys(rec).sort()).toEqual(Object.keys(EXPECTED).sort());
	});

	it("lists the extensions in package.json's order", () => {
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			pi: { extensions: string[] };
		};
		expect(bluclawdExtensions().map((e) => `./ext/${e.name}/index.ts`)).toEqual(manifest.pi.extensions);
	});

	it("has no factory that throws during registration", () => {
		const failures = Object.entries(rec)
			.filter(([, r]) => r.error)
			.map(([name, r]) => `${name}: ${r.error}`);
		expect(failures).toEqual([]);
	});

	for (const [name, expected] of Object.entries(EXPECTED)) {
		it(`${name} registers its expected commands, tools, shortcuts, and event count`, () => {
			const r = rec[name];
			expect(r).toBeDefined();
			expect(r.commands.sort()).toEqual([...expected.commands].sort());
			expect(r.tools.sort()).toEqual([...expected.tools].sort());
			expect(r.shortcuts).toBe(expected.shortcuts);
			expect(r.events.length).toBe(expected.events);
		});
	}
});
