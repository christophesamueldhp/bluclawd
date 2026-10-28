/**
 * The best-effort reaper for a sandboxed command's descendants on macOS, where Seatbelt limits
 * files and network but not process lifetime (#29). A native helper (`native/reaper.c`) follows
 * the command's processes while it runs, by a cookie in their environment and by parent unique
 * id, which survives reparenting to launchd. When the command ends, however it ends, the helper
 * stops and kills every one still running, as Linux's PID namespace does.
 *
 * The helper is compiled on first use with the Command Line Tools into the agent directory; without
 * them commands run unreaped.
 */
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type BashOperations, getAgentDir } from "@earendil-works/pi-coding-agent";

type Exec = BashOperations["exec"];

const execFileAsync = promisify(execFile);
const STOP_TIMEOUT_MS = 2000;
let helper: Promise<string | undefined> | undefined;

async function build(): Promise<string | undefined> {
	try {
		const source = fileURLToPath(new URL("./native/reaper.c", import.meta.url));
		const hash = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 16);
		const dir = join(getAgentDir(), "bluclawd", "reaper");
		const path = join(dir, `reaper-${hash}`);
		if (existsSync(path)) return path;
		// Fails where `cc` would offer to install the Command Line Tools instead.
		await execFileAsync("/usr/bin/xcode-select", ["-p"], { timeout: 5000 });
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const built = `${path}.${process.pid}.tmp`;
		await execFileAsync("/usr/bin/cc", ["-std=c11", "-O2", "-o", built, source], { timeout: 60_000 });
		renameSync(built, path);
		return path;
	} catch {
		return undefined;
	}
}

/** A running helper following the processes whose environment carries its cookie; undefined if none starts. */
async function follow(): Promise<{ cookie: string; reap(): Promise<void> } | undefined> {
	helper ??= build();
	const path = await helper;
	if (!path) return undefined;
	const cookie = randomBytes(32).toString("hex");
	const child = spawn(path, [], { stdio: ["pipe", "pipe", "ignore"] });
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
				const timer = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
				await closed;
				clearTimeout(timer);
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
		const reaper = await follow();
		if (!reaper) return exec(command, cwd, options);
		// Registered before `exec` registers its own, so members freeze before its group kill.
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
