import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capturePrefixes, capturePrompt } from "../scripts/prompt-footprint.ts";

/**
 * The orchestrator's Prompt footprint in characters, as measured when this test was written: trimming lowers it,
 * and nothing may raise it. Lower it when a change makes the footprint smaller.
 */
const CEILING = 23_957;

const platform = Object.getOwnPropertyDescriptor(process, "platform");

// The `subagent` description names the platform off darwin, which makes the footprint larger there.
beforeEach(() => {
	Object.defineProperty(process, "platform", { value: "darwin" });
});

afterEach(() => {
	if (platform) Object.defineProperty(process, "platform", platform);
});

describe("Prompt footprint", () => {
	it("the orchestrator's stays at or under its ceiling", async () => {
		const { footprint } = await capturePrompt();
		expect(footprint).toBeLessThanOrEqual(CEILING);
	});

	it("keeps the system message and the tools byte-identical across consecutive requests", async () => {
		const [first, ...rest] = await capturePrefixes();
		expect(rest).toHaveLength(2);
		for (const prefix of rest) expect(prefix).toBe(first);
	});
});
