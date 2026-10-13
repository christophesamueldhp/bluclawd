// test/remote-tailscale.test.ts
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { pairingText } from "../ext/remote/message.ts";
import {
	commandError,
	connectedName,
	EnableNeeded,
	enablePrompt,
	funnelOn,
	serve,
	serveState,
} from "../ext/remote/tailscale.ts";

const SERVE_OFF = `Serve is not enabled on your tailnet.
To enable, visit:

         https://login.tailscale.com/f/serve?node=nAbC123
`;

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

	it("tells a feature the tailnet has to turn on from the link tailscale prints for it", () => {
		expect(enablePrompt(SERVE_OFF)).toBe(
			"Tailscale Serve is off for your tailnet. Turn it on at https://login.tailscale.com/f/serve?node=nAbC123 (once), then run /remote-control pair.",
		);
		expect(
			enablePrompt(
				"HTTPS is not enabled on your tailnet.\nTo enable, visit:\n\n  https://login.tailscale.com/f/https\n",
			),
		).toBe(
			"Tailscale HTTPS is off for your tailnet. Turn it on at https://login.tailscale.com/f/https (once), then run /remote-control pair.",
		);
		// Until the link has arrived, and for any other output, there is nothing to say yet.
		expect(enablePrompt("Serve is not enabled on your tailnet.\nTo enable, visit:\n")).toBeUndefined();
		expect(enablePrompt("Available on the internet:\nhttps://mac.tail1.ts.net/\n")).toBeUndefined();
	});

	it("stops a tailscale serve that waits for Serve to be turned on, with the link, well before its timeout", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bluclawd-tailscale-"));
		try {
			const fake = join(dir, "tailscale");
			const [head, ...rest] = SERVE_OFF.split("\n\n");
			writeFileSync(
				fake,
				`#!/bin/sh\nprintf '%s\\n\\n' '${head}'\nsleep 0.2\nprintf '%s' '${rest.join("")}'\nexec sleep 30\n`,
			);
			chmodSync(fake, 0o755);
			const started = Date.now();
			const failed = await serve(7878, [fake]).catch((error: unknown) => error);
			expect(Date.now() - started).toBeLessThan(5000);
			expect(failed).toBeInstanceOf(EnableNeeded);
			expect((failed as Error).message).toContain("https://login.tailscale.com/f/serve?node=nAbC123");
			const ok = join(dir, "ok");
			writeFileSync(ok, "#!/bin/sh\necho 'Available within your tailnet'\n");
			chmodSync(ok, 0o755);
			await expect(serve(7878, [ok])).resolves.toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("waits for the whole link, cut across reads, or for tailscale to exit after it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bluclawd-tailscale-"));
		try {
			const cut = join(dir, "cut");
			writeFileSync(
				cut,
				"#!/bin/sh\nprintf 'Serve is not enabled on your tailnet.\\nTo enable, visit:\\n\\n  https://login.tailscale.com/f/ser'\nsleep 0.3\nprintf 've?node=nAbC123\\n'\nexec sleep 30\n",
			);
			chmodSync(cut, 0o755);
			const failed = await serve(7878, [cut]).catch((error: unknown) => error);
			expect(failed).toBeInstanceOf(EnableNeeded);
			expect((failed as Error).message).toContain("https://login.tailscale.com/f/serve?node=nAbC123 (once)");
			const exited = join(dir, "exited");
			writeFileSync(
				exited,
				"#!/bin/sh\nprintf 'Serve is not enabled on your tailnet.\\nTo enable, visit:\\n\\n  https://login.tailscale.com/f/serve?node=nAbC123'\nexit 1\n",
			);
			chmodSync(exited, 0o755);
			const ended = await serve(7878, [exited]).catch((error: unknown) => error);
			expect(ended).toBeInstanceOf(EnableNeeded);
			expect((ended as Error).message).toContain("https://login.tailscale.com/f/serve?node=nAbC123 (once)");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves nothing running when it stops a tailscale that a wrapper script runs without exec", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bluclawd-tailscale-"));
		const marker = `bluclawd-tailscale-child-${process.pid}-${Date.now()}`;
		const running = () => execFileSync("ps", ["-axo", "command"], { encoding: "utf8" }).includes(marker);
		try {
			const wrapper = join(dir, "tailscale");
			// One process with the marker in its argv, started before the link is printed: a process
			// forked as the group is signalled escapes it.
			writeFileSync(
				wrapper,
				`#!/bin/sh\n'${process.execPath}' -e 'setTimeout(() => {}, 30000)' ${marker} &\nsleep 0.3\nprintf '%s' '${SERVE_OFF}'\nwait\n`,
			);
			chmodSync(wrapper, 0o755);
			const failed = await serve(7878, [wrapper]).catch((error: unknown) => error);
			expect(failed).toBeInstanceOf(EnableNeeded);
			await vi.waitFor(() => expect(running()).toBe(false), { timeout: 3000, interval: 50 });
		} finally {
			spawnSync("pkill", ["-f", marker]);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("tells how to pair, with the code in two groups", () => {
		const text = pairingText("https://mac.tail1234.ts.net", "482913", 5 * 60_000, 0);
		expect(text).toContain("https://mac.tail1234.ts.net");
		expect(text).toContain("482 913");
		expect(text).toContain("expires in 5 min");
		expect(text).toContain("Add to Home Screen");
	});
});
