/**
 * Containment of a subagent run's shell commands (spec §6, §10). On macOS every command of a run runs under a
 * Seatbelt profile that names one Mach service only that run's profile names, its marker; `native/run-members.c`
 * finds the run's processes by that profile, which no process can leave, and stops and kills them. That is a check of
 * what runs, not a guess from parentage: unlike the interactive sandbox's reaper (reaper.ts), it finds detached,
 * double-forked, setsid and environment-scrubbed descendants alike, and confirms none is left. It relies on private SPI
 * (`sandbox_check`), so each process tests it once before a run gets a shell. Elsewhere, and where the test fails,
 * runs get no shell.
 */
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { nativeHelper } from "./reaper.ts";

/** What finds a run's processes: the helper, and the Mach name only the run's profile allows. */
export interface RunContainment {
	helper: string;
	marker: string;
}

export type RunContainmentReady = { ok: true; helper: string } | { ok: false; reason: string };

/** The Mach name a run's profile allows; nothing registers it, so allowing it reaches nothing. */
export const runMarker = (runId: string): string => `bluclawd.run.${runId}`;

/** How long the self-test waits for its sandboxed process to be found: it starts slowly on a loaded machine. */
const SELF_TEST_MS = 30_000;
let tested: Promise<RunContainmentReady> | undefined;

/** Whether this machine can contain a run's shell, tested once per process while it can. */
export function prepareRunContainment(platform: NodeJS.Platform = process.platform): Promise<RunContainmentReady> {
	if (platform !== "darwin") {
		return Promise.resolve({
			ok: false,
			reason: `a run's shell commands can be contained, and their processes confirmed ended, only on macOS so far, not on ${platform}`,
		});
	}
	tested ??= selfTest().then((ready) => {
		// Tested again next time; a helper that could not be built is built again only in a new process (reaper.ts).
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

/** The pids of the run's live processes. */
export async function runProcesses({ helper, marker }: RunContainment): Promise<number[]> {
	const { stdout } = await helperRun(helper, ["members", marker]);
	return stdout.split("\n").filter(Boolean).map(Number);
}

/** Stops and kills every process of the run; true once none is left, false when some still live. */
export async function endRunProcesses({ helper, marker }: RunContainment): Promise<boolean> {
	return (await helperRun(helper, ["end", marker])).code === 0;
}

/**
 * A process sandboxed as a run's would be, found among all processes and then ended, and none outside it found: what
 * containment rests on, observed on this machine before any run relies on it.
 */
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
