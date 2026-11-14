import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readinessMs } from "./helpers/heartbeats.ts";
import { conversation, FAUX, type FauxRequest, hasTmux, type RealPi, startRealPi } from "./helpers/real-pi.ts";
import { definitionOf, runDirOf } from "./helpers/run-files.ts";
import { waitFor } from "./helpers/wait-for.ts";

const DRIFTED = fileURLToPath(new URL("./fixtures/real-pi/faux-drifted.ts", import.meta.url));
const ROUTER = fileURLToPath(new URL("./fixtures/real-pi/faux-router.ts", import.meta.url));

/** The last tool result the model was given: the active-run reminder may follow it. */
const lastToolResult = (request: FauxRequest) =>
	conversation(request)
		.filter((message) => message.role === "toolResult")
		.at(-1);

/** What each request of `requests` asked: provider/model:thinking. */
const asked = (requests: FauxRequest[]) =>
	requests.map((request) => `${request.provider}/${request.model}:${request.reasoning ?? "off"}`);

/** The role and settings a run was admitted with. */
const admitted = (agentDir: string, name: string) => definitionOf(runDirOf(agentDir, name));

/** The tool results of the orchestrator's subagent calls, in order. */
const subagentResults = (requests: FauxRequest[]) =>
	requests.slice(1).map((request) => lastToolResult(request)?.text ?? "");

/** An orchestrator whose runs are RPC children, which load `providers` for their model's provider. */
async function startOrchestrator(providers = FAUX): Promise<RealPi> {
	vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", providers);
	return startRealPi();
}

describe.skipIf(!hasTmux)("an RPC run's model and thinking", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	// Two pis one after another (four side by side, then the two left once slots free): a readiness bound for each to
	// start, and one for the rest.
	it(
		"takes each of model and thinking from the call, else the role, else the orchestrator, as its pi asks the model",
		{ timeout: 3 * readinessMs },
		async () => {
			const real = await startOrchestrator();
			pi = real;
			const role = (name: string, defaults: { model?: string; thinkingLevel?: string } = {}) => ({
				name,
				description: "A role.",
				instructions: "Answer.",
				...defaults,
			});
			const tuned = { model: "faux/faux-3", thinkingLevel: "low" };
			const runs: { name: string; args: Record<string, unknown> }[] = [
				{ name: "parents", args: { agent: role("plain") } },
				{ name: "roles", args: { agent: role("tuned", tuned) } },
				{ name: "mixed", args: { agent: role("modelled", { model: "faux/faux-3" }) } },
				{ name: "chosen", args: { agent: role("tuned", tuned), model: "faux/faux-1", thinkingLevel: "off" } },
				{ name: "inherited", args: { agent: role("tuned", tuned), model: "inherit", thinkingLevel: "inherit" } },
				{ name: "half", args: { agent: role("tuned", tuned), model: "inherit" } },
				// The orchestrator's level, which faux-1 cannot think at: refused, not lowered.
				{ name: "refused", args: { agent: role("plain"), model: "faux/faux-1" } },
			];
			// In the background, so the runs start side by side; each Report then wakes the orchestrator.
			real.script("main", [
				...runs.map(({ name, args }) => ({
					tool: "subagent",
					args: { ...args, name, task: "Answer.", background: true },
				})),
				...runs.map(() => ({ text: "noted" })),
			]);
			for (const { name } of runs) real.script(name, [{ text: `${name} answered` }]);
			real.start(["--model", "faux/faux-2", "--thinking", "medium", "--", "delegate"]);
			// Reports may wake it more than once by now.
			await waitFor(() => expect(real.requests("main").length).toBeGreaterThan(runs.length));
			const results = subagentResults(real.requests("main").slice(0, runs.length + 1));
			for (const { name } of runs.slice(0, -1)) await real.waitForRequests(name, 1);

			expect(Object.fromEntries(runs.map(({ name }) => [name, asked(real.requests(name))]))).toEqual({
				parents: ["faux/faux-2:medium"],
				roles: ["faux/faux-3:low"],
				mixed: ["faux/faux-3:medium"],
				chosen: ["faux/faux-1:off"],
				inherited: ["faux/faux-2:medium"],
				half: ["faux/faux-2:low"],
				refused: [],
			});
			// Admitted as resolved, beside the role's own defaults.
			expect(admitted(real.agentDir, "half")).toMatchObject({
				model: "faux/faux-3",
				thinkingLevel: "low",
				admitted: { provider: "faux", modelId: "faux-2", thinkingLevel: "low" },
			});
			expect(results.at(-1)).toContain(
				'Thinking level "medium" is not supported by subagent model "faux/faux-1" (supported: off).',
			);
		},
	);

	// Two pis one after another (lowered, then invented): a readiness bound for each to start, and one for the rest.
	it(
		"fails a run whose pi does not run the admitted model and thinking, before it is given its task",
		{ timeout: 3 * readinessMs },
		async () => {
			// Its pi finds faux-2 unable to think, and no faux-1 at all: pi lowers the level, and takes faux-1 for a
			// custom id it knows nothing of, without failing either way.
			const real = await startOrchestrator(DRIFTED);
			pi = real;
			real.script("main", [
				{
					tool: "subagent",
					args: { agent: "explorer", name: "lowered", task: "Look.", model: "faux/faux-2", thinkingLevel: "high" },
				},
				{
					tool: "subagent",
					args: { agent: "explorer", name: "invented", task: "Look.", model: "faux/faux-1", thinkingLevel: "off" },
				},
				{ text: "both failed" },
			]);
			real.start(["--model", "faux/faux-2", "--thinking", "medium", "--", "delegate"]);
			const [lowered, invented] = subagentResults(await real.waitForRequests("main", 3));

			expect(lowered).toMatch(
				/Outcome: failed: its pi runs faux\/faux-2 at thinking off, not faux\/faux-2 at thinking high\./,
			);
			expect(invented).toMatch(
				/Outcome: failed: its pi cannot use faux\/faux-1: the model is unknown to it, or it has no authentication for it\./,
			);
			expect(real.requests("lowered")).toHaveLength(0);
			expect(real.requests("invented")).toHaveLength(0);
		},
	);

	it("refuses before any run starts a model it does not know or cannot authenticate, and a router it cannot follow", async () => {
		// No key in the environment for openai, whose models pi knows without one.
		vi.stubEnv("OPENAI_API_KEY", undefined);
		const real = await startOrchestrator();
		pi = real;
		const calls: Record<string, unknown>[] = [
			{ model: "faux/faux-9" },
			{ model: "openai/gpt-4.1", thinkingLevel: "off" },
			// The orchestrator's own virtual model: what it routes to is decided per request, after the run started.
			{},
			{ model: "faux-router/auto", thinkingLevel: "high" },
		];
		real.script("main", [
			...calls.map((args, at) => ({
				tool: "subagent",
				args: { agent: "explorer", name: `refused-${at}`, task: "Answer.", ...args },
			})),
			{ text: "none ran" },
		]);
		real.start(["-e", ROUTER, "--model", "faux-router/auto", "--thinking", "high", "--", "delegate"]);
		const results = subagentResults(await real.waitForRequests("main", calls.length + 1));

		expect(results[0]).toContain('Subagent model "faux/faux-9" is not available in the model catalog.');
		expect(results[1]).toContain('No authentication configured for subagent model provider "openai".');
		expect(results[2]).toMatch(
			/Virtual model "faux-router\/auto" cannot be inherited by a subagent: virtual model routers are not inspectable/,
		);
		expect(results[3]).toMatch(/Virtual model "faux-router\/auto" cannot be used by a subagent/);
		// The orchestrator's own requests went where its router sent them.
		expect(asked(real.requests("main"))).toEqual(Array(calls.length + 1).fill("faux/faux-2:high"));
		for (const at of calls.keys()) expect(real.requests(`refused-${at}`)).toHaveLength(0);
	});

	it("keeps the model and thinking it was admitted with when its orchestrator changes its own", async () => {
		const real = await startOrchestrator();
		pi = real;
		const release = join(real.cwd, "release");
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "steady", task: "List.", background: true } },
			{ text: "launched" },
			{ text: "switched" },
			{ text: "noted" },
		]);
		// Its first answer waits until the orchestrator has switched.
		real.script("steady", [{ tool: "ls", args: {}, until: release }, { text: "steady listed" }]);
		const pane = real.start(["--model", "faux/faux-2", "--thinking", "medium", "--", "delegate"]);
		await real.waitForRequests("main", 2);
		await real.waitForRequests("steady", 1);

		real.tmux.sendKeys(pane, ["/model faux/faux-1", "Enter"]);
		await waitFor(() => expect(real.tmux.capture(pane, 50).join("\n")).toContain("Model: faux-1"));
		real.tmux.sendKeys(pane, ["anything new?", "Enter"]);
		expect(asked((await real.waitForRequests("main", 3)).slice(2))).toEqual(["faux/faux-1:off"]);
		writeFileSync(release, "");

		// Its Report wakes the orchestrator, still on its new model.
		const main = await real.waitForRequests("main", 4);
		expect(asked(main.slice(3))).toEqual(["faux/faux-1:off"]);
		expect(conversation(main[3]).at(-1)?.text).toContain("steady listed");
		expect(asked(real.requests("steady"))).toEqual(["faux/faux-2:medium", "faux/faux-2:medium"]);
		expect(admitted(real.agentDir, "steady").admitted).toEqual({
			provider: "faux",
			modelId: "faux-2",
			thinkingLevel: "medium",
		});
	});

	// Two pis one after another (holder, then queued): a readiness bound for each to start, and one for the rest.
	it(
		"keeps the model and thinking a queued run was admitted with when its orchestrator changes its own before the run's turn",
		{ timeout: 3 * readinessMs },
		async () => {
			const real = await startOrchestrator();
			pi = real;
			const settings = join(real.agentDir, "settings.json");
			writeFileSync(
				settings,
				JSON.stringify({
					...JSON.parse(readFileSync(settings, "utf8")),
					subagents: { panes: false, maxActive: 1 },
				}),
			);
			const release = join(real.cwd, "release");
			const queue = join(real.cwd, "queue");
			const background = (name: string) => ({
				tool: "subagent",
				args: { agent: "explorer", name, task: "List.", background: true },
			});
			// One at a time, so the one queued is known: launched side by side, either may claim the slot first.
			real.script("main", [
				background("holder"),
				{ ...background("queued"), until: queue },
				{ text: "launched" },
				{ text: "switched" },
				...Array(3).fill({ text: "noted" }),
			]);
			real.script("holder", [{ text: "holder listed", until: release }]);
			real.script("queued", [{ text: "queued listed" }]);
			const pane = real.start(["--model", "faux/faux-2", "--thinking", "medium", "--", "delegate"]);
			await real.waitForRequests("holder", 1);
			writeFileSync(queue, "");
			await real.waitForRequests("main", 3);

			// The only slot is the holder's, so the other run waits with no model call while the orchestrator switches.
			real.tmux.sendKeys(pane, ["/model faux/faux-1", "Enter"]);
			await waitFor(() => expect(real.tmux.capture(pane, 50).join("\n")).toContain("Model: faux-1"));
			real.tmux.sendKeys(pane, ["anything new?", "Enter"]);
			expect(asked((await real.waitForRequests("main", 4)).slice(3))).toEqual(["faux/faux-1:off"]);
			expect(real.requests("queued")).toEqual([]);
			writeFileSync(release, "");

			expect(asked(await real.waitForRequests("queued", 1))).toEqual(["faux/faux-2:medium"]);
			expect(admitted(real.agentDir, "queued").admitted).toEqual({
				provider: "faux",
				modelId: "faux-2",
				thinkingLevel: "medium",
			});
			await waitFor(() => expect(JSON.stringify(real.requests("main"))).toContain("queued listed"));
			expect(JSON.stringify([...real.requests("main"), ...real.requests("queued")])).not.toContain("ran dry");
		},
	);
});
