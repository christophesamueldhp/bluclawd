import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readinessMs } from "./helpers/heartbeats.ts";
import { DEFAULT_EXTENSIONS, hasTmux, PI_CLI, type RealPi, startRealPi } from "./helpers/real-pi.ts";
import { waitFor } from "./helpers/wait-for.ts";

/** Each test's tmux session that keeps its server up. */
const kept = new Set<string>();

/** The tmux sessions that run pis: not the one that keeps the server up. */
const panes = (real: RealPi) =>
	[...real.screens().matchAll(/^--- (\S+) ---$/gm)].map((match) => match[1]).filter((pane) => !kept.has(pane));

/** A real pi whose tmux server outlives its pis: tmux exits with its last session, and a pane started then fails. */
async function startKept(): Promise<RealPi> {
	const real = await startRealPi({ extensions: [...DEFAULT_EXTENSIONS, "background-bash"] });
	kept.add(real.tmux.newSession({ cwd: real.cwd, command: ["sleep", "3600"], args: [] }));
	return real;
}

/** The session files kept in the runs' directories. */
function runSessionFiles(agentDir: string): string[] {
	const root = join(agentDir, "bluclawd", "subagents");
	if (!existsSync(root)) return [];
	return readdirSync(root).flatMap((session) =>
		readdirSync(join(root, session))
			.filter((run) => run.startsWith("sub_"))
			.flatMap((run) => readdirSync(join(root, session, run)).filter((file) => file.endsWith(".jsonl"))),
	);
}

/**
 * An orchestrator, started by `start`, with one background run, "probe-run", that has reported. Resolves with
 * both panes and the orchestrator's session file.
 */
async function orchestratorWithRun(real: RealPi, start = () => real.start(["--", "delegate the look"])) {
	real.script("main", [
		{ tool: "subagent", args: { agent: "explorer", name: "probe-run", task: "Look around.", background: true } },
		{ text: "waiting for probe-run" },
		{ text: "read the report" },
	]);
	real.script("probe-run", [{ text: "Looked." }]);
	const orchestrator = start();
	await real.waitForRequests("main", 3);
	const [run] = panes(real).filter((pane) => pane !== orchestrator);
	expect(run).toBeDefined();
	const sessionFile = await waitFor(async () => {
		const file = (await real.rows()).find((row) => row.pane === orchestrator)?.sessionFile;
		expect(file).toBeDefined();
		return file ?? "";
	});
	return { orchestrator, run, sessionFile };
}

/** Reopens the orchestrator's session in a new pane: `/tasks` lists "probe-run" as closed, and Enter reopens it. */
async function reopenListsClosedRun(real: RealPi, sessionFile: string) {
	const reopened = real.start(["--session", sessionFile]);
	const screen = () => real.tmux.capture(reopened, 50).join("\n");
	await waitFor(() => expect(screen()).toContain("read the report"));
	real.tmux.sendKeys(reopened, ["/tasks", "Enter"]);
	await waitFor(() => expect(screen()).toMatch(/Done \(1\)\n.*explorer: Look around\..*closed/));
	real.tmux.sendKeys(reopened, ["Enter"]);
	await waitFor(() => expect(panes(real)).toHaveLength(2));
	const [run] = panes(real).filter((pane) => pane !== reopened);
	await waitFor(() => expect(real.tmux.capture(run, 50).join("\n")).toContain("Looked."));
}

describe.skipIf(!hasTmux)("a run's lifetime", () => {
	let pi: RealPi | undefined;
	let held: number | undefined;
	afterEach(async () => {
		// A stopped pi ignores the hang-up that ends its pane.
		if (held) process.kill(held, "SIGKILL");
		held = undefined;
		await pi?.stop();
		pi = undefined;
	});

	it("ends with its orchestrator's session: a quit closes the run and keeps its session, and reopening lists it as resumable", async () => {
		const real = await startKept();
		pi = real;
		const { orchestrator, sessionFile } = await orchestratorWithRun(real);

		real.tmux.sendKeys(orchestrator, ["/quit", "Enter"]);
		await waitFor(() => expect(panes(real)).toEqual([]));
		expect(runSessionFiles(real.agentDir)).toHaveLength(1);

		await reopenListsClosedRun(real, sessionFile);
	});

	it(
		"stays open while its orchestrator's pane is Silent, is closed by the daemon once that pane is gone, and reopening lists it as resumable",
		async () => {
			const real = await startKept();
			pi = real;
			// tmux continues a pane's stopped process, so the orchestrator's pi runs under a shell that stays.
			const { orchestrator, run, sessionFile } = await orchestratorWithRun(real, () =>
				real.tmux.newSession({
					cwd: real.cwd,
					command: ["/bin/sh", "-c", '"$@"; :', "sh", process.execPath, PI_CLI],
					args: ["--model", "faux/faux-1", "--", "delegate the look"],
				}),
			);
			const shell = spawnSync(
				"tmux",
				["-S", real.tmux.socket, "display-message", "-p", "-t", `=${orchestrator}:`, "#{pane_pid}"],
				{ encoding: "utf8" },
			).stdout.trim();
			held = Number(spawnSync("pgrep", ["-P", shell], { encoding: "utf8" }).stdout.trim());
			// Never 0, which would stop this whole process group.
			expect(held).toBeGreaterThan(0);

			// Held up, as by a Mac asleep: it misses its heartbeats while tmux still has its pane.
			process.kill(held, "SIGSTOP");
			await waitFor(async () =>
				expect((await real.rows()).find((row) => row.pane === orchestrator)).toMatchObject({ silent: true }),
			);
			// The run beats every 3 s, and each beat asks after its orchestrator's pane.
			await new Promise((resolve) => setTimeout(resolve, 7000));
			expect(panes(real)).toContain(run);

			// Gone for good: its pi dies without ending its session, and its pane goes with it.
			process.kill(held, "SIGKILL");
			held = undefined;
			await waitFor(() => expect(panes(real)).not.toContain(orchestrator));
			await waitFor(() => expect(panes(real)).not.toContain(run));
			expect(runSessionFiles(real.agentDir)).toHaveLength(1);

			await reopenListsClosedRun(real, sessionFile);
		},
		3 * readinessMs,
	);
});
