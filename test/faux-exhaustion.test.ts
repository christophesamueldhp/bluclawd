import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createVitest } from "vitest/node";
import { readinessMs } from "./helpers/heartbeats.ts";

const fixture = fileURLToPath(new URL("./fixtures/faux-exhaustion/dry-queue.ts", import.meta.url));

describe("a faux provider asked for a response it never queued", () => {
	it("fails the test that asked, naming it", { timeout: 2 * readinessMs }, async () => {
		// A nested run under the suite's own config: setup files included, its reporters muted.
		const vitest = await createVitest("test", { include: [fixture], reporters: [{}], watch: false });
		try {
			const { testModules } = await vitest.start([fixture]);
			const results = [...testModules[0].children.allTests()].map((test) => test.result());
			expect(results).toEqual([
				expect.objectContaining({
					state: "failed",
					errors: [
						expect.objectContaining({
							message: expect.stringContaining(
								'faux queue ran dry in "asks for one response more than it queued"',
							),
						}),
					],
				}),
			]);
		} finally {
			await vitest.close();
		}
	});
});
