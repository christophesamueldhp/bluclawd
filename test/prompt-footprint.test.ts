import { afterEach, describe, expect, it } from "vitest";
import { ALL_TOOLS, capturePrefixes, capturePrompt } from "../scripts/prompt-footprint.ts";

/**
 * The orchestrator's Prompt footprint in characters, in its default profile and with all tools declared, as measured
 * when this test was written: trimming lowers it, and nothing may raise it. Lower it when a change makes the footprint
 * smaller.
 */
const PROFILES = { "the default profile": {}, "all tools declared": ALL_TOOLS };
const CEILINGS = { "the default profile": 16_592, "all tools declared": 22_914 };

/** Each bundled role's run footprint, held the same way. */
const RUN_CEILINGS = { explorer: 2_789, "general-purpose": 3_858, reviewer: 2_989 };

const platform = Object.getOwnPropertyDescriptor(process, "platform");

afterEach(() => {
	if (platform) Object.defineProperty(process, "platform", platform);
});

describe("Prompt footprint", () => {
	it.each(Object.entries(CEILINGS))(
		"the orchestrator's in %s stays at or under its ceiling",
		async (name, ceiling) => {
			// The `subagent` description names the platform off darwin, which makes the footprint larger there.
			Object.defineProperty(process, "platform", { value: "darwin" });
			const { footprint } = await capturePrompt(PROFILES[name as keyof typeof PROFILES]);
			expect(footprint).toBeLessThanOrEqual(ceiling);
		},
	);

	it("a session with no setting does not declare monitor, nor name it in a snippet or guideline", async () => {
		const { tools, system } = await capturePrompt();
		expect(tools.map((tool) => tool.name)).not.toContain("monitor");
		// pi's snippet per tool and its guidelines are lines of these two sections.
		expect(`${system.sections?.tools}\n${system.sections?.rules}`).not.toMatch(/\bmonitor\b/);
	});

	it.each([
		["the defaultTools setting", { defaultTools: ["+monitor"] }],
		["--tools", { tools: ["+monitor"] }],
	])("a session given monitor by %s declares it, with its snippet", async (_route, profile) => {
		const { tools, system } = await capturePrompt(profile);
		expect(tools.map((tool) => tool.name)).toContain("monitor");
		expect(system.sections?.tools).toMatch(/^- monitor: /m);
	});

	it("a session with no setting declares neither schedule_wakeup nor memory, nor names them, nor has <memory>", async () => {
		const { tools, system } = await capturePrompt();
		expect(tools.map((tool) => tool.name)).not.toContain("schedule_wakeup");
		expect(tools.map((tool) => tool.name)).not.toContain("memory");
		expect(system.sections?.memory).toBeUndefined();
		expect(JSON.stringify({ system, tools })).not.toMatch(/schedule_wakeup|\bmemory\b/i);
	});

	it.each([
		["the defaultTools setting", { defaultTools: ["+schedule_wakeup", "+memory"] }],
		["--tools", { tools: ["+schedule_wakeup", "+memory"] }],
	])("a session given schedule_wakeup and memory by %s declares both, with <memory>", async (_route, profile) => {
		const { tools, system } = await capturePrompt(profile);
		expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["schedule_wakeup", "memory"]));
		expect(system.sections?.memory).toContain("Memory index");
	});

	it.each(Object.entries(RUN_CEILINGS))("a run of %s stays at or under its ceiling", async (role, ceiling) => {
		// Off darwin a run gets no shell, which changes what general-purpose is told.
		Object.defineProperty(process, "platform", { value: "darwin" });
		const { footprint } = await capturePrompt({ role });
		expect(footprint).toBeLessThanOrEqual(ceiling);
	});

	it.each(Object.entries(PROFILES))(
		"keeps the system message and the tools byte-identical across consecutive requests in %s",
		async (_name, profile) => {
			const [first, ...rest] = await capturePrefixes(profile);
			expect(rest).toHaveLength(2);
			for (const prefix of rest) expect(prefix).toBe(first);
		},
	);
});
