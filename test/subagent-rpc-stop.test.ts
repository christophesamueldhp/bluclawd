import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	conversation,
	FAUX,
	type FauxRequest,
	hasTmux,
	type RealPi,
	startRealPi,
	toolNames,
} from "./helpers/real-pi.ts";
import { waitFor } from "./helpers/wait-for.ts";

/** A run's directory, as its orchestrator stored it, by the run's name. */
function runDir(agentDir: string, name: string): string {
	const root = join(agentDir, "bluclawd", "subagents");
	for (const session of readdirSync(root)) {
		for (const run of readdirSync(join(root, session))) {
			const record = join(root, session, run, "record.json");
			if (existsSync(record) && JSON.parse(readFileSync(record, "utf8")).name === name)
				return join(root, session, run);
		}
	}
	throw new Error(`no run named ${name}`);
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const recordOf = (real: RealPi, name: string) => readJson(join(runDir(real.agentDir, name), "record.json"));
const hostOf = (real: RealPi, name: string) => readJson(join(runDir(real.agentDir, name), "rpc-host.json"));

/** Merges `added` into the settings every pi of the test reads, as they are read next. */
function addSettings(real: RealPi, added: Record<string, unknown>): void {
	const path = join(real.agentDir, "settings.json");
	writeFileSync(path, JSON.stringify({ ...readJson(path), ...added }));
}

/** The text of the last tool result the model was given. */
const lastToolResult = (request: FauxRequest) =>
	conversation(request)
		.filter((message) => message.role === "toolResult")
		.at(-1)?.text;

/** Whether any process of the group `pid` leads still runs: a run's host leads its own, its pi and theirs in it. */
const groupAlive = (pid: number) => {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
};

const LINGERER = fileURLToPath(new URL("./fixtures/real-pi/lingerer.ts", import.meta.url));

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** An orchestrator pane whose runs are RPC children, which load the faux provider, and `extensions`, as the pane does. */
async function startOrchestrator(extensions: string[] = []): Promise<RealPi> {
	vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", [FAUX, ...extensions].join(":"));
	return startRealPi();
}

/** A launch of an explorer named `name`, in the background unless `foreground`. */
const launch = (name: string, foreground = false) => ({
	tool: "subagent",
	args: { agent: "explorer", name, task: `Look, ${name}.`, ...(foreground ? {} : { background: true }) },
});

describe.skipIf(!hasTmux)("stopping an RPC run", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	it("cancels a foreground run when its call is cancelled, and leaves one launched in the background working", async () => {
		const real = await startOrchestrator();
		pi = real;
		const gate = join(real.cwd, "back.go");
		real.script("main", [{ calls: [launch("back"), launch("fore", true)] }, { text: "read back's report" }]);
		real.script("fore", [{ text: "Never.", until: join(real.cwd, "never") }]);
		real.script("back", [{ text: "Back done.", until: gate }]);
		const pane = real.start(["--", "delegate"]);
		await real.waitForRequests("fore", 1);
		await real.waitForRequests("back", 1);
		// Its runs end their processes by themselves: the model stops their work, and has nothing to close.
		const tools = toolNames(real.requests("main")[0]);
		expect(tools).toEqual(expect.arrayContaining(["subagent", "subagent_stop", "subagent_resume"]));
		expect(tools).not.toContain("subagent_close");

		real.tmux.sendKeys(pane, ["Escape"]);
		await waitFor(() => expect(recordOf(real, "fore").status).toBe("cancelled"));
		// Final only once nothing of it runs: its host, its pi, and whatever they started in its group.
		expect(groupAlive(hostOf(real, "fore").hostPid)).toBe(false);
		expect(readJson(join(runDir(real.agentDir, "fore"), "reports", "1.json")).outcome).toMatchObject({
			status: "stopped",
		});
		expect(real.requests("fore")).toHaveLength(1);

		expect(recordOf(real, "back").status).toBe("running");
		writeFileSync(gate, "");
		await real.waitForRequests("main", 2);
		await waitFor(() => expect(recordOf(real, "back").status).toBe("closed"));
		expect(readJson(join(runDir(real.agentDir, "back"), "reports", "1.json")).outcome).toEqual({
			status: "completed",
		});
	});

	it("cancels a queued run before it starts: it never gets a process or a model call, even once a slot frees", async () => {
		const real = await startOrchestrator();
		pi = real;
		addSettings(real, { subagents: { maxActive: 1 } });
		const gate = join(real.cwd, "first.go");
		real.script("main", [
			{ calls: [launch("first"), launch("queued")] },
			{ text: "waiting" },
			{ tool: "subagent_stop", args: { agent: "queued" } },
			{ text: "stopped it" },
			{ text: "read first's report" },
		]);
		real.script("first", [{ text: "First done.", until: gate }]);
		real.script("queued", [{ text: "Never." }]);
		const pane = real.start(["--", "delegate"]);
		await real.waitForRequests("first", 1);
		await real.waitForRequests("main", 2);
		expect(recordOf(real, "queued").status).toBe("starting");

		real.tmux.sendKeys(pane, ["stop queued", "Enter"]);
		const main = await real.waitForRequests("main", 4);
		expect(lastToolResult(main[3])).toMatch(/^Stopped "queued" \(sub_[\w-]+\): its work was cancelled/);
		expect(recordOf(real, "queued")).toMatchObject({ status: "cancelled", stopSource: "model" });

		writeFileSync(gate, "");
		await real.waitForRequests("main", 5);
		await waitFor(() => expect(groupAlive(hostOf(real, "first").hostPid)).toBe(false));
		// Proves only that it does not start within this while, the slot free.
		await new Promise((resolve) => setTimeout(resolve, 1000));
		expect(existsSync(join(runDir(real.agentDir, "queued"), "rpc-host.json"))).toBe(false);
		expect(real.requests("queued")).toHaveLength(0);
		expect(recordOf(real, "queued").status).toBe("cancelled");
	});

	it("keeps a stopped run's session and Report, lets no late message, Report or reload restart it, and resumes it only when asked", async () => {
		const real = await startOrchestrator();
		pi = real;
		real.script("main", [
			launch("work"),
			{ text: "waiting" },
			{ tool: "subagent_stop", args: { agent: "work" } },
			{ text: "stopped it" },
			{ tool: "subagent_message", args: { to: "work", content: "Carry on." } },
			{ text: "it takes no message" },
			{ tool: "subagent_resume", args: { agent: "work", task: "Now finish." } },
			{ text: "resumed it" },
			{ text: "read its report" },
		]);
		real.script("work", [{ text: "Never.", until: join(real.cwd, "never") }, { text: "Finished." }]);
		const pane = real.start(["--", "delegate"]);
		await real.waitForRequests("work", 1);
		await real.waitForRequests("main", 2);

		real.tmux.sendKeys(pane, ["stop work", "Enter"]);
		await real.waitForRequests("main", 4);
		const dir = runDir(real.agentDir, "work");
		const stopped = recordOf(real, "work");
		expect(stopped).toMatchObject({ status: "cancelled", generation: 0 });
		expect(readFileSync(stopped.transcriptPath, "utf8")).toContain("Look, work.");
		expect(readJson(join(dir, "reports", "1.json")).outcome).toMatchObject({ status: "stopped" });

		real.tmux.sendKeys(pane, ["message work", "Enter"]);
		const main = await real.waitForRequests("main", 6);
		expect(lastToolResult(main[5])).toMatch(
			/^Message \d+ unavailable: "work" \(sub_[\w-]+\) was stopped\. Only subagent_resume continues it/,
		);
		real.tmux.sendKeys(pane, ["/reload", "Enter"]);
		await waitFor(() => expect(real.tmux.capture(pane, 50).join("\n")).toMatch(/Reloaded/i));
		// Proves only that neither its Report nor the reload woke anyone, nor started it, within this while.
		await new Promise((resolve) => setTimeout(resolve, 1000));
		expect(real.requests("main")).toHaveLength(6);
		expect(real.requests("work")).toHaveLength(1);
		expect(recordOf(real, "work")).toMatchObject({ status: "cancelled", generation: 0 });

		real.tmux.sendKeys(pane, ["resume work", "Enter"]);
		await real.waitForRequests("main", 9);
		const [, resumed] = real.requests("work");
		// Its earlier context, the turn it was stopped in among it.
		expect(conversation(resumed).map(({ role, text }) => `${role}: ${text.split("\n").at(-1)}`)).toEqual([
			"user: Look, work.",
			"assistant: ",
			"user: Now finish.",
		]);
		expect(recordOf(real, "work")).toMatchObject({ status: "closed", generation: 1 });
	});

	it("is cancelled only once nothing of it runs: what its pi left in its process group is ended first", async () => {
		const real = await startOrchestrator([LINGERER]);
		pi = real;
		real.script("main", [
			launch("stay"),
			{ text: "waiting" },
			{ tool: "subagent_stop", args: { agent: "stay" } },
			{ text: "stopped it" },
		]);
		real.script("stay", [{ text: "Never.", until: join(real.cwd, "never") }]);
		const pane = real.start(["--", "delegate"]);
		await real.waitForRequests("stay", 1);
		await real.waitForRequests("main", 2);
		const lingerer = Number(readFileSync(join(real.cwd, "lingerer.pid"), "utf8"));

		real.tmux.sendKeys(pane, ["stop stay", "Enter"]);
		const { hostPid, childPid } = hostOf(real, "stay");
		await waitFor(() => expect([alive(hostPid), alive(childPid)]).toEqual([false, false]));
		// Asked to stop, its host and pi gone, but not cancelled while anything it started still runs.
		expect(alive(lingerer)).toBe(true);
		expect(recordOf(real, "stay").status).toBe("stopping");

		const main = await real.waitForRequests("main", 4);
		expect(lastToolResult(main[3])).toMatch(/^Stopped "stay" \(sub_[\w-]+\): its work was cancelled/);
		expect(alive(lingerer)).toBe(false);
		expect(recordOf(real, "stay").status).toBe("cancelled");
	});
});
