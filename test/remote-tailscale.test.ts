// test/remote-tailscale.test.ts
import { describe, expect, it } from "vitest";
import { pairingText } from "../ext/remote/message.ts";
import { dnsNameOf, servesPort } from "../ext/remote/tailscale.ts";

describe("remote control: tailscale and pairing text", () => {
	it("reads the tailnet name without its trailing dot", () => {
		expect(dnsNameOf({ Self: { DNSName: "mac.tail1234.ts.net." } })).toBe("mac.tail1234.ts.net");
		expect(dnsNameOf({ Self: { DNSName: "" } })).toBeUndefined();
		expect(dnsNameOf({})).toBeUndefined();
	});

	it("detects a serve proxy to exactly this port", () => {
		const config = { Web: { "mac.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7878" } } } } };
		expect(servesPort(config, 7878)).toBe(true);
		expect(servesPort(config, 787)).toBe(false);
		expect(servesPort({}, 7878)).toBe(false);
	});

	it("tells how to pair, with the code in two groups", () => {
		const text = pairingText("https://mac.tail1234.ts.net", "482913", 5 * 60_000, 0);
		expect(text).toContain("https://mac.tail1234.ts.net");
		expect(text).toContain("482 913");
		expect(text).toContain("expires in 5 min");
		expect(text).toContain("Add to Home Screen");
	});
});
