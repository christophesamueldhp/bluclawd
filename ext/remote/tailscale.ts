// ext/remote/tailscale.ts
/**
 * The phone reaches remote control through Tailscale: `tailscale serve` proxies this machine's
 * tailnet HTTPS name to the daemon's 127.0.0.1 listener, reachable only from the tailnet.
 */
import { execFile } from "node:child_process";

export type ServeState = "ours" | "other" | "none";

export interface TailscaleInfo {
	installed: boolean;
	/** `host.tailnet.ts.net`, when connected. */
	dnsName?: string;
	/** What the tailnet name's `/` handler proxies: this port, something else, or nothing. */
	serve: ServeState;
	/** Tailscale Funnel exposes the name to the public internet. */
	funnel: boolean;
}

const TIMEOUT_MESSAGE = "tailscale did not finish within 10s";

export function commandError(
	error: { message: string; killed?: boolean; signal?: string | null },
	stdout: string,
	stderr: string,
): string {
	const output = [stderr, stdout]
		.map((s) => s.trim())
		.filter(Boolean)
		.join("\n");
	const text = output || error.message;
	return error.killed === true || error.signal ? `${TIMEOUT_MESSAGE}\n${text}` : text;
}

function run(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("tailscale", args, { timeout: 10_000 }, (error, stdout, stderr) => {
			if (!error) return resolve(stdout);
			error.message = commandError(error, stdout, stderr);
			reject(error);
		});
	});
}

/** The tailnet name (`Self.DNSName` ends with the DNS root's dot), only while Tailscale is running. */
export function connectedName(status: unknown): string | undefined {
	const s = status as { BackendState?: unknown; Self?: { DNSName?: unknown } } | null | undefined;
	const name = s?.Self?.DNSName;
	if (s?.BackendState !== "Running" || typeof name !== "string" || !name) return undefined;
	return name.replace(/\.$/, "") || undefined;
}

/** Looks only at the `/` handler of `<host>:443` in `tailscale serve status --json`. */
export function serveState(config: unknown, host: string, port: number): ServeState {
	const web = (config as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }> } | null)?.Web;
	const proxy = web?.[`${host}:443`]?.Handlers?.["/"]?.Proxy;
	if (typeof proxy !== "string") return "none";
	const ours = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
	return ours.includes(proxy.replace(/\/$/, "")) ? "ours" : "other";
}

export function funnelOn(config: unknown, host: string): boolean {
	return (config as { AllowFunnel?: Record<string, unknown> } | null)?.AllowFunnel?.[`${host}:443`] === true;
}

export async function tailscaleInfo(port: number): Promise<TailscaleInfo> {
	let status: unknown;
	try {
		status = JSON.parse(await run(["status", "--json"]));
	} catch (error) {
		return { installed: (error as NodeJS.ErrnoException).code !== "ENOENT", serve: "none", funnel: false };
	}
	const dnsName = connectedName(status);
	if (!dnsName) return { installed: true, serve: "none", funnel: false };
	let config: unknown;
	try {
		config = JSON.parse(await run(["serve", "status", "--json"]));
	} catch {
		// no serve configuration yet
	}
	return { installed: true, dnsName, serve: serveState(config, dnsName, port), funnel: funnelOn(config, dnsName) };
}

/** Proxy https://<this machine's tailnet name>/ to 127.0.0.1:<port>, in the background. */
export async function serve(port: number): Promise<void> {
	await run(["serve", "--bg", String(port)]);
}
