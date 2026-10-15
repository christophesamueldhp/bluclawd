import { describe, expect, it } from "vitest";
import { pairLink } from "../daemon/remote/web/api.js";

describe("the phone app's pairing links", () => {
	const secret = "Qm3xZ8vT1pLk9sWc2rYb0A";

	it("takes the QR code's secret from #pair= and the Home Screen app's handoff from #handoff=", () => {
		expect(pairLink(`#pair=${secret}`)).toEqual({ secret });
		expect(pairLink("#handoff=Zx9-_aBcDeFgHiJkLmNoPq")).toEqual({ handoff: "Zx9-_aBcDeFgHiJkLmNoPq" });
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
			`#handoff=${secret.slice(1)}`,
			`#other=${secret}`,
			"#s/pane-1",
		]) {
			expect(pairLink(hash), hash).toBeUndefined();
		}
	});
});
