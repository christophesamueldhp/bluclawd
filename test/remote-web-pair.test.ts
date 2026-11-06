import { describe, expect, it } from "vitest";
import { pairLink } from "#remote-web/api.js";

describe("the phone app's pairing links", () => {
	const secret = "Qm3xZ8vT1pLk9sWc2rYb0A";

	it("takes the QR code's secret from #pair=", () => {
		expect(pairLink(`#pair=${secret}`)).toEqual({ secret });
	});

	it("takes nothing else", () => {
		for (const hash of [
			"",
			"#",
			"#pair=482913",
			`#pair=${secret.slice(1)}`,
			`#pair=${secret}A`,
			`#pair=${secret}&x`,
			`#pair=${secret.slice(1)}+`,
			`#handoff=${secret}`,
			`#other=${secret}`,
			"#s/pane-1",
		]) {
			expect(pairLink(hash), hash).toBeUndefined();
		}
	});
});
