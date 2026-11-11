import { describe, expect, it } from "vitest";
import { processAlive, processGroupAlive } from "../daemon/processes.ts";

describe("probing a process by its pid", () => {
	it("takes another user's process for one that exists, and a pid no process has for none", () => {
		// pid 1 is the system's own: signalling it is not permitted, which says it exists.
		expect(processAlive(1)).toBe(true);
		expect(processAlive(process.pid)).toBe(true);
		expect(processAlive(2 ** 22 + 7)).toBe(false);
		expect(processGroupAlive(2 ** 22 + 7)).toBe(false);
	});
});
