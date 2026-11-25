import { vi } from "vitest";
import { readinessMs } from "./heartbeats.ts";

export function waitFor<T>(check: () => T): Promise<Exclude<T, false>> {
	const stillFalseWithCallerStack = new Error(`condition still false after ${readinessMs}ms`);
	// biome-ignore lint/plugin: the one place that sizes vi.waitFor's deadline.
	return vi.waitFor(
		() => {
			const result = check();
			if (result === false) throw stillFalseWithCallerStack;
			return result as Exclude<T, false>;
		},
		{ timeout: readinessMs },
	);
}

export async function waitWhileProgressing<T>(check: () => T, progress: () => number): Promise<T> {
	for (;;) {
		const seen = progress();
		const outcome = await waitFor(() => {
			try {
				return { met: check() };
			} catch (error) {
				if (progress() > seen) return undefined;
				throw error;
			}
		});
		if (outcome) return outcome.met;
	}
}
