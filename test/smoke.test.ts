import { VERSION } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

describe("bluclawd test infra", () => {
	it("resolves @earendil-works/pi-coding-agent to pi's source", () => {
		expect(typeof VERSION).toBe("string");
	});
});
