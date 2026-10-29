import { vi } from "vitest";
import { readinessMs } from "./heartbeats.ts";

/**
 * `vi.waitFor` with its deadline sized for a loaded machine, not vitest's 1s default: the deadline is a failure
 * bound, not a timing estimate. `READINESS_MS` widens it with every other wait.
 * A check returning `false` counts as not met yet, so a predicate polls like an assertion does.
 */
export function waitFor<T>(check: () => T): Promise<T> {
	// Made here, so its stack names the caller's wait rather than vitest's timer.
	const stillFalse = new Error(`condition still false after ${readinessMs}ms`);
	// biome-ignore lint/plugin: the one place that sizes vi.waitFor's deadline.
	return vi.waitFor(
		() => {
			const result = check();
			if (result === false) throw stillFalse;
			return result;
		},
		{ timeout: readinessMs },
	);
}
