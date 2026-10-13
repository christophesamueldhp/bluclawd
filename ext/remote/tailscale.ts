/**
 * The phone reaches remote control through Tailscale: `tailscale serve` proxies this machine's
 * tailnet HTTPS name to the daemon's 127.0.0.1 listener, reachable only from the tailnet.
 */
import { spawn } from "node:child_process";

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

/** A feature the tailnet has not turned on: tailscale prints where to turn it on, then waits. */
export class EnableNeeded extends Error {}

/** What to tell the user once tailscale's "… is not enabled … visit <link>" has arrived. The link
 *  counts once whitespace follows it: until then, its next read may carry more of it. */
export function enablePrompt(output: string): string | undefined {
	const line = output.split("\n").find((l) => /not enabled/i.test(l));
	const url = /https:\/\/login\.tailscale\.com\/\S+(?=\s)/.exec(output)?.[0];
	if (!line || !url) return undefined;
	const feature = /\bHTTPS\b/i.test(line) ? "HTTPS" : "Serve";
	return `Tailscale ${feature} is off for your tailnet. Turn it on at ${url} (once), then run /remote-control pair.`;
}

/** The macOS app ships its CLI inside the bundle and puts it on PATH only when asked to. */
const BINARIES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

async function run(
	args: string[],
	binaries = BINARIES,
	watch?: (output: string) => string | undefined,
): Promise<string> {
	for (const [i, binary] of binaries.entries()) {
		try {
			return await runWith(binary, args, watch);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || i === binaries.length - 1) throw error;
		}
	}
	throw new Error("unreachable");
}

/** `watch`: read the output as it arrives; a message from it ends the command at once. */
function runWith(binary: string, args: string[], watch?: (output: string) => string | undefined): Promise<string> {
	return new Promise((resolve, reject) => {
		// Its own process group, ended whole: a wrapper script that runs tailscale without exec would
		// otherwise leave it waiting.
		const child = spawn(binary, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const kill = () => {
			if (child.pid === undefined) return;
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {
				child.kill();
			}
		};
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, 10_000);
		let stdout = "";
		let stderr = "";
		let output = "";
		let stopped = false;
		const read = (chunk: string) => {
			if (stopped || !watch) return;
			output += chunk;
			const message = watch(output);
			if (!message) return;
			stopped = true;
			reject(new EnableNeeded(message));
			kill();
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			read(chunk);
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
			read(chunk);
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) return resolve(stdout);
			// Exited after printing the link last, with nothing after it.
			const message = stopped ? undefined : watch?.(`${output}\n`);
			if (message) return reject(new EnableNeeded(message));
			const failed = { message: `Command failed: ${binary} ${args.join(" ")}`, killed: timedOut, signal };
			reject(new Error(commandError(failed, stdout, stderr)));
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

/** Proxy https://<this machine's tailnet name>/ to 127.0.0.1:<port>, in the background. Throws
 *  EnableNeeded when the tailnet has Serve or HTTPS off, which tailscale would wait on. */
export async function serve(port: number, binaries = BINARIES): Promise<void> {
	await run(["serve", "--bg", String(port)], binaries, enablePrompt);
}
