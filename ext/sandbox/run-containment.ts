import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { endLinuxRun, linuxRunMembers } from "../../daemon/linux-run-members.ts";
import { runMachMarker } from "../../daemon/run-members.ts";
import { nativeHelper } from "./reaper.ts";

/** `helper` finds a run's processes on macOS; Linux has none, and reads /proc. */
export interface RunContainment {
	helper?: string;
	marker: string;
}

export type RunContainmentReady = { ok: true; helper?: string } | { ok: false; reason: string };

const SELF_TEST_MS = 30_000;
let tested: Promise<RunContainmentReady> | undefined;

export function prepareRunContainment(platform: NodeJS.Platform = process.platform): Promise<RunContainmentReady> {
	if (platform !== "darwin" && platform !== "linux") {
		return Promise.resolve({
			ok: false,
			reason: `a run's shell commands can be contained, and their processes confirmed ended, only on macOS and Linux, not on ${platform}`,
		});
	}
	tested ??= (platform === "linux" ? linuxSelfTest() : selfTest()).then((ready) => {
		if (!ready.ok) tested = undefined;
		return ready;
	});
	return tested;
}

function helperRun(helper: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
	return new Promise((resolve) => {
		execFile(helper, args, { encoding: "utf8", timeout: SELF_TEST_MS }, (error, stdout) =>
			resolve({ code: error ? (typeof error.code === "number" ? error.code : null) : 0, stdout }),
		);
	});
}

export async function runProcesses({ helper, marker }: RunContainment): Promise<number[]> {
	if (helper === undefined) return linuxRunMembers(marker);
	const { stdout } = await helperRun(helper, ["members", marker]);
	return stdout.split("\n").filter(Boolean).map(Number);
}

export async function endRunProcesses({ helper, marker }: RunContainment): Promise<boolean> {
	if (helper === undefined) return endLinuxRun(marker);
	return (await helperRun(helper, ["end", marker])).code === 0;
}

async function selfTest(): Promise<RunContainmentReady> {
	const built = await nativeHelper("run-members");
	if ("problem" in built) return { ok: false, reason: `its processes cannot be found and ended: ${built.problem}` };
	const contained = { helper: built.path, marker: `bluclawd.selftest.${randomUUID()}` };
	const failed = (why: string): RunContainmentReady => ({
		ok: false,
		reason: `this machine fails the test that a run's processes are found and ended: ${why}`,
	});
	const profile = `(version 1)(allow default)(deny mach-lookup (global-name "${contained.marker}.control"))`;
	const probe = spawn("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sleep", "60"], { stdio: "ignore" });
	probe.on("error", () => {});
	const exited = new Promise<void>((resolve) => probe.once("exit", () => resolve()));
	try {
		const deadline = Date.now() + SELF_TEST_MS;
		for (;;) {
			const found = await runProcesses(contained);
			if (found.includes(process.pid)) return failed("a process outside the sandbox was taken for one in it");
			if (probe.pid !== undefined && found.includes(probe.pid)) break;
			if (probe.exitCode !== null || Date.now() > deadline) return failed("a sandboxed process was not found");
			await sleep(50);
		}
		if (!(await endRunProcesses(contained))) return failed("a sandboxed process outlived being ended");
		await exited;
		return { ok: true, helper: built.path };
	} finally {
		probe.kill("SIGKILL");
	}
}

/**
 * A bubblewrap started the way srt starts one for a run's command, whose detached process must be found from
 * here and ended. Refused without srt's seccomp helper: a command could then hand work to a service over a Unix
 * socket, outside its PID namespace.
 */
async function linuxSelfTest(): Promise<RunContainmentReady> {
	const failed = (why: string): RunContainmentReady => ({
		ok: false,
		reason: `this machine fails the test that a run's processes are found and ended: ${why}`,
	});
	const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
	const { errors, warnings } = SandboxManager.checkDependencies();
	if (errors.length > 0) return failed(errors.join("; "));
	if (warnings.some((warning) => /seccomp/i.test(warning))) return failed(warnings.join("; "));
	const runId = `selftest-${randomUUID()}`;
	const contained = { marker: runMachMarker(runId) };
	const root = mkdtempSync(join(tmpdir(), "bluclawd-containment-"));
	const runTmp = join(root, "bluclawd", "run-tmp", runId);
	mkdirSync(runTmp, { recursive: true });
	const probe = spawn(
		"bwrap",
		[
			...["--new-session", "--die-with-parent", "--unshare-pid", "--unshare-user"],
			...["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--bind", runTmp, runTmp],
			...["/bin/sh", "-c", "setsid sleep 60 </dev/null >/dev/null 2>&1 & exec sleep 60"],
		],
		{ stdio: "ignore" },
	);
	probe.on("error", () => {});
	try {
		const deadline = Date.now() + SELF_TEST_MS;
		for (;;) {
			const found = linuxRunMembers(contained.marker);
			if (found.includes(process.pid)) return failed("a process outside the sandbox was taken for one in it");
			if (probe.pid !== undefined && found.includes(probe.pid) && found.length >= 4) break;
			if (probe.exitCode !== null || Date.now() > deadline) return failed("a sandboxed process was not found");
			await sleep(50);
		}
		if (!(await endRunProcesses(contained))) return failed("a sandboxed process outlived being ended");
		return { ok: true };
	} catch (error) {
		return failed(error instanceof Error ? error.message : String(error));
	} finally {
		probe.kill("SIGKILL");
		rmSync(root, { recursive: true, force: true });
	}
}
