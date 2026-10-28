/**
 * The best-effort reaper for a sandboxed command's descendants on macOS, where Seatbelt does not
 * limit process lifetime (#29): `native/reaper.c` follows the command's processes and kills them
 * when it ends. The helper is compiled when the sandbox starts, with the Command Line Tools, into
 * the agent directory, outside the sandbox's writable paths; without them commands run unreaped,
 * and the sandbox says so.
 */
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type BashOperations, getAgentDir } from "@earendil-works/pi-coding-agent";

type Exec = BashOperations["exec"];

const execFileAsync = promisify(execFile);
const REAP_WAIT_MS = 2000;
type Helper = { path: string } | { problem: string };
let helper: Promise<Helper> | undefined;

async function build(): Promise<Helper> {
	try {
		const source = fileURLToPath(new URL("./native/reaper.c", import.meta.url));
		const hash = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 16);
		const dir = join(getAgentDir(), "bluclawd", "reaper");
		const path = join(dir, `reaper-${hash}`);
		if (existsSync(path)) return { path };
		// Fails where `cc` would offer to install the Command Line Tools instead.
		const tools = await execFileAsync("/usr/bin/xcode-select", ["-p"], { timeout: 5000 }).then(
			() => true,
			() => false,
		);
		if (!tools)
			return { problem: "the Command Line Tools are not installed; run xcode-select --install and restart pi" };
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const built = `${path}.${process.pid}.tmp`;
		await execFileAsync("/usr/bin/cc", ["-std=c11", "-O2", "-o", built, source], { timeout: 60_000 });
		renameSync(built, path);
		return { path };
	} catch (error) {
		return { problem: `its helper could not be built: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** Builds the helper ahead of the first command; what keeps it from running, if anything. */
export async function prepareReaper(): Promise<string | undefined> {
	if (process.platform !== "darwin") return undefined;
	helper ??= build();
	const built = await helper;
	return "problem" in built ? built.problem : undefined;
}

/** A helper following the processes whose environment carries its cookie; undefined if none starts. */
async function startReaper(): Promise<{ cookie: string; reap(): Promise<void> } | undefined> {
	helper ??= build();
	const built = await helper;
	if ("problem" in built) return undefined;
	const { path } = built;
	const cookie = randomBytes(32).toString("hex");
	// Its own session, so a hangup of pi's terminal leaves it to reap.
	const child = spawn(path, [], { stdio: ["pipe", "pipe", "ignore"], detached: true });
	child.on("error", () => {});
	child.stdin.on("error", () => {});
	const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
	child.stdin.write(`${cookie}\n`);
	const ready = await new Promise<boolean>((resolve) => {
		child.stdout.once("data", () => resolve(true));
		void closed.then(() => resolve(false));
	});
	if (!ready) return undefined;
	let reaped: Promise<void> | undefined;
	return {
		cookie,
		reap: () => {
			reaped ??= (async () => {
				child.stdin.end("stop\n");
				// Never killed: a helper cut short would leave the members it stopped frozen.
				await Promise.race([closed, sleep(REAP_WAIT_MS, undefined, { ref: false })]);
				child.unref();
			})();
			return reaped;
		},
	};
}

/**
 * `exec` whose command's descendants are killed when it ends, on macOS; `exec` itself elsewhere.
 * The command must be a simple command, as `srt`'s wrap is: the cookie is set as its prefix.
 */
export function reapDescendants(exec: Exec): Exec {
	if (process.platform !== "darwin") return exec;
	return async (command, cwd, options) => {
		const reaper = await startReaper();
		if (!reaper) return exec(command, cwd, options);
		// Reaps from the abort on, without waiting for the shell to exit.
		const reap = () => void reaper.reap();
		options.signal?.addEventListener("abort", reap, { once: true });
		try {
			return await exec(`BLUCLAWD_REAPER_COOKIE=${reaper.cookie} ${command}`, cwd, options);
		} finally {
			options.signal?.removeEventListener("abort", reap);
			await reaper.reap();
		}
	};
}
