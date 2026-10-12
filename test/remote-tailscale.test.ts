// test/remote-tailscale.test.ts
import { describe, expect, it } from "vitest";
import { pairingText } from "../ext/remote/message.ts";
import { commandError, connectedName, funnelOn, serveState } from "../ext/remote/tailscale.ts";

const serveConfig = (path: string, proxy: string) => ({
	TCP: { "443": { HTTPS: true } },
	Web: { "mac.tail1.ts.net:443": { Handlers: { [path]: { Proxy: proxy } } } },
});

describe("remote control: tailscale and pairing text", () => {
	it("is connected only when running, and drops the trailing dot", () => {
		expect(connectedName({ BackendState: "Running", Self: { DNSName: "mac.tail1.ts.net." } })).toBe(
			"mac.tail1.ts.net",
		);
		expect(connectedName({ BackendState: "NeedsLogin", Self: { DNSName: "mac.tail1.ts.net." } })).toBeUndefined();
		expect(connectedName({ BackendState: "Stopped", Self: { DNSName: "mac.tail1.ts.net." } })).toBeUndefined();
		expect(connectedName({ BackendState: "Running", Self: { DNSName: "" } })).toBeUndefined();
		expect(connectedName({})).toBeUndefined();
		expect(connectedName(undefined)).toBeUndefined();
	});

	it("tells whether the root handler proxies this port", () => {
		const host = "mac.tail1.ts.net";
		expect(serveState(serveConfig("/", "http://127.0.0.1:7878"), host, 7878)).toBe("ours");
		expect(serveState(serveConfig("/", "http://localhost:7878/"), host, 7878)).toBe("ours");
		expect(serveState(serveConfig("/", "http://127.0.0.1:3000"), host, 7878)).toBe("other");
		expect(serveState(serveConfig("/", "http://127.0.0.1:78780"), host, 7878)).toBe("other");
		expect(serveState(serveConfig("/x", "http://127.0.0.1:7878"), host, 7878)).toBe("none");
		expect(serveState(serveConfig("/", "http://127.0.0.1:7878"), "other.ts.net", 7878)).toBe("none");
		expect(serveState({}, host, 7878)).toBe("none");
		expect(serveState(null, host, 7878)).toBe("none");
	});

	it("reads the funnel flag for the host", () => {
		expect(funnelOn({ AllowFunnel: { "mac.tail1.ts.net:443": true } }, "mac.tail1.ts.net")).toBe(true);
		expect(funnelOn({ AllowFunnel: { "mac.tail1.ts.net:443": false } }, "mac.tail1.ts.net")).toBe(false);
		expect(funnelOn({}, "mac.tail1.ts.net")).toBe(false);
	});

	it("builds command errors from both streams and flags timeouts", () => {
		expect(commandError({ message: "Command failed" }, "serve is not enabled\n", "")).toBe("serve is not enabled");
		expect(commandError({ message: "Command failed" }, "out", " err\n")).toBe("err\nout");
		expect(commandError({ message: "Command failed" }, "", "")).toBe("Command failed");
		expect(commandError({ message: "x", killed: true, signal: "SIGTERM" }, "partial", "")).toBe(
			"tailscale did not finish within 10s\npartial",
		);
		expect(commandError({ message: "x", signal: "SIGTERM" }, "", "")).toBe("tailscale did not finish within 10s\nx");
	});

	it("tells how to pair, with the code in two groups", () => {
		const text = pairingText("https://mac.tail1234.ts.net", "482913", 5 * 60_000, 0);
		expect(text).toContain("https://mac.tail1234.ts.net");
		expect(text).toContain("482 913");
		expect(text).toContain("expires in 5 min");
		expect(text).toContain("Add to Home Screen");
	});
});
