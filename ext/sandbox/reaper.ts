/**
 * The best-effort reaper for a sandboxed command's descendants on macOS, where Seatbelt does not
 * limit process lifetime (#29). `native/reaper.c` follows the command's processes and kills them
 * when it ends.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { type BashOperations, getAgentDir } from "@earendil-works/pi-coding-agent";
import { nativeHelperPath } from "../../daemon/run-members.ts";

type Exec = BashOperations["exec"];

const execFileAsync = promisify(execFile);
const REAP_WAIT_MS = 2000;
export type Helper = { path: string } | { problem: string };
const buildsInThisProcess = new Map<string, Promise<Helper>>();

export function nativeHelper(name: string): Promise<Helper> {
	let helper = buildsInThisProcess.get(name);
	if (!helper) {
		helper = build(name);
		buildsInThisProcess.set(name, helper);
	}
	return helper;
}

async function build(name: string): Promise<Helper> {
	try {
		const { source, path } = nativeHelperPath(name, getAgentDir());
		const dir = dirname(path);
		if (existsSync(path)) return { path };
		// Fails where `cc` would offer to install the Command Line Tools instead.
		const tools = await execFileAsync("/usr/bin/xcode-select", ["-p"], { timeout: 5000 }).then(
			() => true,
			() => false,
		);
		if (!tools) return { problem: "the Command Line Tools are not installed (xcode-select --install)" };
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const built = `${path}.${process.pid}.tmp`;
		await execFileAsync("/usr/bin/cc", ["-std=c11", "-O2", "-o", built, source], { timeout: 60_000 });
		renameSync(built, path);
		return { path };
	} catch (error) {
		const firstErrorLine = (error instanceof Error ? error.message : String(error)).split("\n")[0];
		return { problem: `its helper could not be built: ${firstErrorLine}` };
	}
}

export async function prepareReaper(): Promise<string | undefined> {
	if (process.platform !== "darwin") return undefined;
	const built = await nativeHelper("reaper");
	return "problem" in built ? built.problem : undefined;
}

function spawnOutsideTerminalSession(path: string) {
	return spawn(path, [], { stdio: ["pipe", "pipe", "ignore"], detached: true });
}

async function waitThenAbandonHelper(helper: ChildProcess, closed: Promise<void>): Promise<void> {
	await Promise.race([closed, sleep(REAP_WAIT_MS, undefined, { ref: false })]);
	helper.unref();
}

async function startReaper(): Promise<{ cookie: string; reap(): Promise<void> } | undefined> {
	const built = await nativeHelper("reaper");
	if ("problem" in built) return undefined;
	const { path } = built;
	const cookie = randomBytes(32).toString("hex");
	const child = spawnOutsideTerminalSession(path);
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
				await waitThenAbandonHelper(child, closed);
			})();
			return reaped;
		},
	};
}

export function reapDescendantsOfSimpleCommand(exec: Exec): Exec {
	if (process.platform !== "darwin") return exec;
	return async (command, cwd, options) => {
		const reaper = await startReaper();
		if (!reaper) return exec(command, cwd, options);
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
