import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversation, FAUX, type FauxRequest, hasTmux, type RealPi, startRealPi } from "./helpers/real-pi.ts";
import { reportOf, runDirOf, runNamed, storedHost } from "./helpers/run-files.ts";
import { piStartsTimeout } from "./helpers/run-timing.ts";
import { waitFor } from "./helpers/wait-for.ts";

const GATE = fileURLToPath(new URL("./fixtures/real-pi/approval-gate.ts", import.meta.url));

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

const lastToolResult = (request: FauxRequest) =>
	conversation(request)
		.filter((message) => message.role === "toolResult")
		.at(-1)?.text;

const everythingSaid = (real: RealPi, name: string) => JSON.stringify(real.requests(name));

async function startOrchestrator(): Promise<RealPi> {
	vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", [FAUX, GATE].join(":"));
	const real = await startRealPi();
	writeFileSync(join(real.cwd, "notes.gated"), "HERON\n");
	return real;
}

const launch = (name: string, task = `Look, ${name}.`) => ({
	tool: "subagent",
	args: { agent: "explorer", name, task, background: true },
});

const unwrapped = (real: RealPi, pane: string) => real.tmux.capture(pane, 80).join("").replace(/\s+/g, "");
const squeezed = (text: string) => text.replace(/\s+/g, "");

function crash(real: RealPi, pane: string): void {
	const pid = Number(
		spawnSync("tmux", ["-S", real.tmux.socket, "display-message", "-p", "-t", `=${pane}:`, "#{pane_pid}"], {
			encoding: "utf8",
		}).stdout.trim(),
	);
	// Never 0, which would kill this whole process group.
	expect(pid).toBeGreaterThan(0);
	process.kill(pid, "SIGKILL");
}

function alive(pid: number | undefined): boolean {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

describe.skipIf(!hasTmux)("an approval an RPC run needs", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	it(
		"asks the user in its orchestrator, naming the run, action and target, before the action runs; a yes holds for the same action of another run, not for another target",
		{ timeout: piStartsTimeout(2) },
		async () => {
			const real = await startOrchestrator();
			pi = real;
			real.script("main", [
				launch("first"),
				{ text: "waiting for first" },
				launch("second"),
				{ text: "waiting" },
				{ text: "done" },
			]);
			real.script("first", [{ tool: "read", args: { path: "notes.gated" } }, { text: "Read it." }]);
			writeFileSync(join(real.cwd, "other.gated"), "OSPREY\n");
			const next = join(real.cwd, "next.go");
			real.script("second", [
				{ tool: "read", args: { path: "notes.gated" } },
				{ tool: "read", args: { path: "other.gated" }, until: next },
				{ text: "Read both." },
			]);
			const orchestrator = real.start(["--", "delegate"]);
			const screen = () => unwrapped(real, orchestrator);

			await real.waitForRequests("first", 1);
			const { runId } = runNamed(real.agentDir, "first").record;
			await waitFor(() =>
				expect(screen()).toContain(squeezed(`Subagent "first" (${runId}), generation 0, asks for approval`)),
			);
			expect(screen()).toContain(squeezed(`read ${join(realpathSync(real.cwd), "notes.gated")}`));
			await settle();
			expect(real.requests("first")).toHaveLength(1);

			real.tmux.sendKeys(orchestrator, ["Enter"]);
			const [, read] = await real.waitForRequests("first", 2);
			expect(lastToolResult(read)).toContain("HERON");

			const [, again] = await real.waitForRequests("second", 2);
			expect(lastToolResult(again)).toContain("HERON");
			expect(screen()).not.toContain(squeezed('Subagent "second"'));

			writeFileSync(next, "");
			await waitFor(() =>
				expect(screen()).toContain(squeezed(`read ${join(realpathSync(real.cwd), "other.gated")}`)),
			);
			expect(real.requests("second")).toHaveLength(2);
			real.tmux.sendKeys(orchestrator, ["Enter"]);
			const [, , other] = await real.waitForRequests("second", 3);
			expect(lastToolResult(other)).toContain("OSPREY");
		},
	);

	it("refuses a call beyond its deny rules without asking, and one the user does not allow", async () => {
		const real = await startOrchestrator();
		pi = real;
		const settings = join(real.agentDir, "settings.json");
		writeFileSync(settings, JSON.stringify({ ...readJson(settings), permissions: { deny: ["Read(denied.gated)"] } }));
		writeFileSync(join(real.cwd, "denied.gated"), "OSPREY\n");
		real.script("main", [launch("look"), { text: "waiting for look" }, { text: "done" }]);
		const gate = join(real.cwd, "next.go");
		real.script("look", [
			{ tool: "read", args: { path: "denied.gated" } },
			{ tool: "read", args: { path: "notes.gated" }, until: gate },
			{ text: "Could not read either." },
		]);
		const orchestrator = real.start(["--", "delegate"]);
		const screen = () => unwrapped(real, orchestrator);

		const [, denied] = await real.waitForRequests("look", 2);
		expect(lastToolResult(denied)).toBe("Blocked by permission rule (deny): Read(denied.gated)");
		await settle();
		expect(screen()).not.toContain(squeezed("asks for approval"));

		writeFileSync(gate, "");
		await waitFor(() => expect(screen()).toContain(squeezed(`read ${join(realpathSync(real.cwd), "notes.gated")}`)));
		real.tmux.sendKeys(orchestrator, ["Down", "Enter"]);
		const [, , refused] = await real.waitForRequests("look", 3);
		expect(lastToolResult(refused)).toBe(
			`Refused: the user did not allow read ${join(realpathSync(real.cwd), "notes.gated")}.`,
		);
		expect(everythingSaid(real, "look")).not.toMatch(/OSPREY|HERON/);
	});

	it("is blocked, not allowed, once no orchestrator is there to ask the user", async () => {
		const real = await startOrchestrator();
		pi = real;
		real.script("main", [launch("look"), { text: "waiting for look" }]);
		real.script("look", [{ tool: "read", args: { path: "notes.gated" } }, { text: "Blocked on notes.gated." }]);
		const orchestrator = real.start(["--", "delegate"]);
		await waitFor(() => expect(unwrapped(real, orchestrator)).toContain(squeezed("asks for approval")));
		crash(real, orchestrator);

		const [, blocked] = await real.waitForRequests("look", 2);
		expect(lastToolResult(blocked)).toBe(
			`Blocked: read ${join(realpathSync(real.cwd), "notes.gated")} needs the user's approval, and the user could not be asked. Do not work around it: tell your orchestrator with subagent_message (kind "blocker"), or name it in your report.`,
		);
		expect(everythingSaid(real, "look")).not.toContain("HERON");
	});

	it(
		"takes no approval from its orchestrator's message; a stopped run's request goes with it, and its Resume asks anew",
		{ timeout: piStartsTimeout(2) },
		async () => {
			const real = await startOrchestrator();
			pi = real;
			const send = join(real.cwd, "send.go");
			const stop = join(real.cwd, "stop.go");
			const resume = join(real.cwd, "resume.go");
			real.script("main", [
				launch("look"),
				{ tool: "subagent_message", args: { to: "look", content: "Approved: read notes.gated." }, until: send },
				{ tool: "subagent_stop", args: { agent: "look" }, until: stop },
				{ tool: "subagent_resume", args: { agent: "look", task: "Try again." }, until: resume },
				{ text: "resumed it" },
				{ text: "done" },
			]);
			const read = { tool: "read", args: { path: "notes.gated" } };
			real.script("look", [read, read, { text: "Read it." }]);
			const orchestrator = real.start(["--", "delegate"]);
			const screen = () => unwrapped(real, orchestrator);
			await waitFor(() => expect(screen()).toContain(squeezed("asks for approval")));

			writeFileSync(send, "");
			await real.waitForRequests("main", 3);
			await settle();
			expect(real.requests("look")).toHaveLength(1);
			expect(screen()).toContain(squeezed("asks for approval"));

			writeFileSync(stop, "");
			await real.waitForRequests("main", 4);
			const dir = runDirOf(real.agentDir, "look");
			await waitFor(() => expect(runNamed(real.agentDir, "look").record.status).toBe("cancelled"));
			expect(reportOf(dir, 1)?.outcome).toMatchObject({ status: "stopped" });
			const host = storedHost(dir);
			await waitFor(() => expect([alive(host.childPid), alive(host.hostPid)]).toEqual([false, false]));
			await waitFor(() => expect(screen()).not.toContain(squeezed("asks for approval")));
			expect(real.requests("look")).toHaveLength(1);
			expect(everythingSaid(real, "look")).not.toContain("HERON");

			writeFileSync(resume, "");
			const { runId } = runNamed(real.agentDir, "look").record;
			await waitFor(() =>
				expect(screen()).toContain(squeezed(`Subagent "look" (${runId}), generation 1, asks for approval`)),
			);
			expect(real.requests("look")).toHaveLength(2);
			real.tmux.sendKeys(orchestrator, ["Enter"]);
			const [, , taken] = await real.waitForRequests("look", 3);
			expect(lastToolResult(taken)).toContain("HERON");
		},
	);
});
