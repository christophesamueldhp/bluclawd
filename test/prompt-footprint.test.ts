import { afterEach, describe, expect, it } from "vitest";
import { capturePrefixes, capturePrompt } from "../scripts/prompt-footprint.ts";

/**
 * The orchestrator's Prompt footprint in characters, as measured when this test was written: trimming lowers it,
 * and nothing may raise it. Lower it when a change makes the footprint smaller.
 */
const CEILING = 22_738;

/** Each bundled role's run footprint, held the same way. */
const RUN_CEILINGS = { explorer: 2_789, "general-purpose": 3_858, reviewer: 2_989 };

const platform = Object.getOwnPropertyDescriptor(process, "platform");

afterEach(() => {
	if (platform) Object.defineProperty(process, "platform", platform);
});

describe("Prompt footprint", () => {
	it("the orchestrator's stays at or under its ceiling", async () => {
		// The `subagent` description names the platform off darwin, which makes the footprint larger there.
		Object.defineProperty(process, "platform", { value: "darwin" });
		const { footprint } = await capturePrompt();
		expect(footprint).toBeLessThanOrEqual(CEILING);
	});

	it.each(Object.entries(RUN_CEILINGS))("a run of %s stays at or under its ceiling", async (role, ceiling) => {
		// Off darwin a run gets no shell, which changes what general-purpose is told.
		Object.defineProperty(process, "platform", { value: "darwin" });
		const { footprint } = await capturePrompt({ role });
		expect(footprint).toBeLessThanOrEqual(ceiling);
	});

	it("keeps the system message and the tools byte-identical across consecutive requests", async () => {
		const [first, ...rest] = await capturePrefixes();
		expect(rest).toHaveLength(2);
		for (const prefix of rest) expect(prefix).toBe(first);
	});
});
