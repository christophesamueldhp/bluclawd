import { describe, expect, it, vi } from "vitest";
import { waitFor } from "./helpers/wait-for.ts";

describe("waitFor", () => {
	it("keeps polling a predicate until it holds", async () => {
		let checks = 0;
		await waitFor(() => ++checks === 3);
		expect(checks).toBe(3);
	});

	it("keeps polling an assertion until it passes, and returns what the check returns", async () => {
		let checks = 0;
		const text = await waitFor(() => {
			if (++checks < 3) throw new Error("not yet");
			return "written";
		});
		expect(text).toBe("written");
	});
});

describe("waitWhileProgressing", () => {
	const bound = 2000;
	/** The helpers, their deadline set to `bound` as READINESS_MS sets it. */
	async function helpers() {
		vi.stubEnv("READINESS_MS", String(bound));
		vi.resetModules();
		return import("./helpers/wait-for.ts");
	}
	/** Progress that grows with the clock until `stop`, `forMs` from now, however rarely it is polled. */
	function progressFor(forMs: number) {
		const stop = Date.now() + forMs;
		return { progress: () => Math.min(Date.now(), stop), stop };
	}

	it("keeps waiting past its deadline while progress goes on", async () => {
		const { waitWhileProgressing } = await helpers();
		const { progress } = progressFor(3 * bound);
		const start = Date.now();
		const met = await waitWhileProgressing(() => {
			if (Date.now() - start < 2 * bound) throw new Error("not yet");
			return "met";
		}, progress);
		expect(met).toBe("met");
	});

	it("fails with the check's error one deadline after progress stopped", async () => {
		const { waitWhileProgressing } = await helpers();
		// Just past one deadline: a wait that only looked at progress once per deadline would fail nearly two after.
		const { progress, stop } = progressFor(1.1 * bound);
		await expect(
			waitWhileProgressing(() => {
				throw new Error("never met");
			}, progress),
		).rejects.toThrow("never met");
		const stalledFor = Date.now() - stop;
		expect(stalledFor).toBeGreaterThanOrEqual(bound);
		expect(stalledFor).toBeLessThan(1.5 * bound);
	});
});
