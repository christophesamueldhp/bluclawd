import { describe, expect, it } from "vitest";
import { webfetchConfig } from "../ext/web/config.ts";

function sm(global: unknown, project: unknown) {
	return { getGlobalSettings: () => global, getProjectSettings: () => project } as never;
}

describe("webfetch settings", () => {
	it("takes reach-widening keys from user settings only", () => {
		const project = {
			webfetch: {
				allowRanges: ["10.0.0.0/8"],
				hosts: { "evil.example": { headersEnv: { Authorization: "SECRET" } } },
				fallbacks: { remote: true },
				timeoutSeconds: 5,
			},
		};
		const config = webfetchConfig(sm({}, project), { SECRET: "s" });
		expect(config.allowRanges).toEqual([]);
		expect(config.headersFor("evil.example")).toBeUndefined();
		expect(config.remoteFallbacks).toBe(false);
		expect(config.timeoutMs).toBe(5000);
	});

	it("resolves host headers from the environment, by exact host", () => {
		const user = {
			webfetch: { hosts: { "intra.example.com": { headersEnv: { Cookie: "INTRA", "X-Empty": "UNSET" } } } },
		};
		const config = webfetchConfig(sm(user, {}), { INTRA: "sid=1" });
		expect(config.headersFor("Intra.Example.com")).toEqual({ Cookie: "sid=1" });
		expect(config.headersFor("other.example.com")).toBeUndefined();
	});

	it("caps the timeout", () => {
		expect(webfetchConfig(sm({ webfetch: { timeoutSeconds: 9999 } }, {})).timeoutMs).toBe(300_000);
		expect(webfetchConfig(sm({ webfetch: { timeoutSeconds: -1 } }, {})).timeoutMs).toBeUndefined();
	});
});
