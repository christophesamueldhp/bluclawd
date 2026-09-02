import { describe, expect, it } from "vitest";
import { recordExtensions } from "../scripts/probe-extensions.ts";

/**
 * Turns `probe-extensions.ts`'s printed table into an assertion. This is the
 * check sync-pi.sh exists to run on every upstream merge: an upstream rename
 * that breaks a factory at registration time typechecks fine (the type it
 * changed may still structurally match) and only throws here.
 */
const EXPECTED: Record<string, { commands: string[]; tools: string[]; shortcuts: number; events: number }> = {
	permissions: { commands: ["mode", "permissions"], tools: [], shortcuts: 1, events: 3 },
	statusline: { commands: ["statusline"], tools: [], shortcuts: 0, events: 3 },
	memory: { commands: ["memory"], tools: ["memory"], shortcuts: 0, events: 2 },
	checkpoints: { commands: ["rewind"], tools: [], shortcuts: 0, events: 3 },
	subagents: { commands: ["agents"], tools: ["task"], shortcuts: 0, events: 0 },
	web: { commands: [], tools: ["webfetch", "websearch"], shortcuts: 0, events: 0 },
	mcp: { commands: ["mcp"], tools: [], shortcuts: 0, events: 2 },
	sandbox: { commands: ["sandbox"], tools: ["bash"], shortcuts: 0, events: 3 },
	"background-bash": { commands: ["tasks"], tools: ["bash_output", "kill_bash"], shortcuts: 0, events: 0 },
	branding: { commands: [], tools: [], shortcuts: 0, events: 1 },
	diagnostics: { commands: ["context"], tools: [], shortcuts: 0, events: 0 },
	fleet: { commands: ["fleet"], tools: [], shortcuts: 0, events: 2 },
	help: { commands: ["help"], tools: [], shortcuts: 0, events: 0 },
};

describe("bluclawd extension registration", () => {
	const rec = recordExtensions();

	it("registers exactly the 13 expected extensions, no more, no fewer", () => {
		expect(Object.keys(rec).sort()).toEqual(Object.keys(EXPECTED).sort());
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
