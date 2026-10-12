// ext/remote/tailscale.ts
/**
 * The phone reaches remote control through Tailscale: `tailscale serve` proxies this machine's
 * tailnet HTTPS name to the daemon's 127.0.0.1 listener, reachable only from the tailnet.
 */
import { execFile } from "node:child_process";

export interface TailscaleInfo {
	installed: boolean;
	/** `host.tailnet.ts.net`, when logged in. */
	dnsName?: string;
	/** `tailscale serve` already proxies the port. */
	serving: boolean;
}

function run(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("tailscale", args, { timeout: 10_000 }, (error, stdout, stderr) => {
			if (!error) return resolve(stdout);
			error.message = stderr.trim() || error.message;
			reject(error);
		});
	});
}

/** `Self.DNSName` ends with the DNS root's dot. */
export function dnsNameOf(status: unknown): string | undefined {
	const name = (status as { Self?: { DNSName?: unknown } } | undefined)?.Self?.DNSName;
	return typeof name === "string" && name ? name.replace(/\.$/, "") : undefined;
}

/** Whether `tailscale serve status --json` shows a proxy to this port. */
export function servesPort(config: unknown, port: number): boolean {
	const text = JSON.stringify(config ?? {});
	return text.includes(`127.0.0.1:${port}"`) || text.includes(`localhost:${port}"`);
}

export async function tailscaleInfo(port: number): Promise<TailscaleInfo> {
	let status: unknown;
	try {
		status = JSON.parse(await run(["status", "--json"]));
	} catch (error) {
		return { installed: (error as NodeJS.ErrnoException).code !== "ENOENT", serving: false };
	}
	let serving = false;
	try {
		serving = servesPort(JSON.parse(await run(["serve", "status", "--json"])), port);
	} catch {
		// no serve configuration yet
	}
	return { installed: true, dnsName: dnsNameOf(status), serving };
}

/** Proxy https://<this machine's tailnet name>/ to 127.0.0.1:<port>, in the background. */
export async function serve(port: number): Promise<void> {
	await run(["serve", "--bg", String(port)]);
}
