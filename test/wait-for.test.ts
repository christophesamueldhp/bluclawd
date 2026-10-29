import { describe, expect, it } from "vitest";
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
