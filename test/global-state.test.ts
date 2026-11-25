import { describe, expect, it } from "vitest";
import { sharedRef } from "../ext/_shared/global-state.ts";

/**
 * pi's package loader gives each top-level extension its own module graph
 * (`loadExtensionModule`, `moduleCache: false`), so a plain module-level `let`
 * in a file imported by two different top-level extensions is NOT
 * shared, since each gets its own instance.
 *
 * A dynamic import with a cache-busting query string simulates two separately
 * loaded copies of the same source file, the same way jiti's `moduleCache:
 * false` does for two different top-level extensions.
 */
describe("sharedRef", () => {
	it("is visible across two separately-loaded copies of its module", async () => {
		const path = new URL("../ext/_shared/global-state.ts", import.meta.url).pathname;
		const a = (await import(`${path}?copy=a`)) as typeof import("../ext/_shared/global-state.ts");
		const b = (await import(`${path}?copy=b`)) as typeof import("../ext/_shared/global-state.ts");

		expect(a.sharedRef).not.toBe(sharedRef);

		const refA = a.sharedRef<number>("test.crossInstance", 0);
		const refB = b.sharedRef<number>("test.crossInstance", 0);

		refA.set(42);
		expect(refB.get()).toBe(42);
	});

	it("does not reinitialize an existing value", () => {
		const first = sharedRef("test.noReinit", "first");
		first.set("changed");
		const second = sharedRef("test.noReinit", "first");
		expect(second.get()).toBe("changed");
	});
});
