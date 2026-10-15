import { describe, expect, it } from "vitest";
import { pairCode } from "../daemon/remote/web/api.js";

describe("the pairing link's code (the phone app's #pair=<code>)", () => {
	it("is the six digits after #pair=, and nothing else is", () => {
		expect(pairCode("#pair=482913")).toBe("482913");
		for (const hash of ["", "#", "#pair=48291", "#pair=4829130", "#pair=48291a", "#pair=482913&x", "#s/pane-1"]) {
			expect(pairCode(hash)).toBeUndefined();
		}
	});
});
