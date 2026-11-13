import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "@earendil-works/pi-ai";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readinessMs } from "./helpers/heartbeats.ts";
import {
	conversation,
	FAUX,
	type FauxRequest,
	hasTmux,
	type RealPi,
	startRealPi,
	systemPrompt,
	toolNames,
} from "./helpers/real-pi.ts";

/** The last tool result the model was given: the active-run reminder may follow it. */
const lastToolResult = (request: FauxRequest) =>
	conversation(request)
		.filter((message) => message.role === "toolResult")
		.at(-1);

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

/** A saved role `name` whose instructions are `body`, in `dir`'s project roles or, with `sub`, under `dir/sub`. */
function role(dir: string, name: string, body: string, sub = join(".pi", "agents"), extra: string[] = []): void {
	mkdirSync(join(dir, sub), { recursive: true });
	writeFileSync(
		join(dir, sub, `${name}.md`),
		["---", `name: ${name}`, `description: ${body}`, ...extra, "---", body].join("\n"),
	);
}

/** An orchestrator pane whose runs are RPC children, which load the faux provider as the pane does. */
async function startOrchestrator(): Promise<RealPi> {
	vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", FAUX);
	return startRealPi();
}

describe.skipIf(!hasTmux)("an RPC run's directory and role", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	it("works in the directory it was given, relative to its orchestrator's", async () => {
		const real = await startOrchestrator();
		pi = real;
		const pkg = join(real.cwd, "pkg");
		mkdirSync(pkg);
		writeFileSync(join(pkg, "here.txt"), "inside pkg\n");
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "look", cwd: "pkg", task: "Read here.txt." } },
			{ text: "done" },
		]);
		real.script("look", [{ tool: "read", args: { path: "here.txt" } }, { text: "It says inside pkg." }]);
		real.start(["--", "delegate"]);
		await real.waitForRequests("main", 2);

		const look = real.requests("look");
		expect(systemPrompt(look[0])).toContain(realpathSync(pkg));
		expect(lastToolResult(look[1])).toMatchObject({ toolName: "read", text: "inside pkg\n" });
		expect(JSON.parse(readFileSync(join(runDir(real.agentDir, "look"), "record.json"), "utf8")).cwd).toBe(
			realpathSync(pkg),
		);
	});

	// Five runs in a row, each a new pi: a readiness bound for each to start, and one for the rest.
	it(
		"takes its role from an inline, the nearest project, a user or a bundled definition, looking no higher than its repository",
		{ timeout: 6 * readinessMs },
		async () => {
			const real = await startOrchestrator();
			pi = real;
			const repo = join(real.cwd, "repo");
			const pkg = join(repo, "pkg");
			mkdirSync(pkg, { recursive: true });
			spawnSync("git", ["init", "-q"], { cwd: repo });
			role(real.cwd, "explorer", "Workspace explorer.");
			role(real.cwd, "outsider", "Above the repository.");
			role(repo, "explorer", "Repository explorer.");
			role(pkg, "explorer", "Package explorer.");
			// The user trusts the workspace, as /trust saves it: its directories inherit that decision.
			new ProjectTrustStore(real.agentDir).set(realpathSync(real.cwd), true);
			role(real.agentDir, "explorer", "User explorer.", "agents");
			const inline = { name: "explorer", description: "Inline.", instructions: "Inline explorer." };
			const launches: Array<JsonObject & { name: string }> = [
				{ agent: inline, name: "inline", cwd: "repo/pkg" },
				{ agent: "explorer", name: "project", cwd: "repo/pkg" },
				{ agent: "explorer", name: "user", cwd: "repo/pkg", agentScope: "user" },
				{ agent: "reviewer", name: "bundled", cwd: "repo/pkg" },
				{ agent: "explorer", name: "default" },
				{ agent: "outsider", name: "outside", cwd: "repo/pkg" },
			];
			real.script("main", [
				...launches.map((args) => ({ tool: "subagent", args: { ...args, task: "Say hi." } })),
				{ text: "done" },
			]);
			for (const { name } of launches) real.script(name, [{ text: "Hi." }]);
			real.start(["--", "delegate"]);
			const main = await real.waitForRequests("main", launches.length + 1);

			const prompt = (name: string) => systemPrompt(real.requests(name)[0]);
			expect(prompt("inline")).toContain("Inline explorer.");
			expect(prompt("project")).toContain("Package explorer.");
			expect(prompt("user")).toContain("User explorer.");
			expect(prompt("bundled")).toContain("You are `reviewer`");
			expect(prompt("default")).toContain("Workspace explorer.");
			for (const name of ["inline", "project", "user", "bundled"]) expect(prompt(name)).toContain(realpathSync(pkg));
			expect(prompt("default")).toContain(realpathSync(real.cwd));
			expect(lastToolResult(main[launches.length])?.text).toMatch(/Unknown subagent "outsider"/);
			expect(real.requests("outside")).toHaveLength(0);
		},
	);

	it("runs a project's roles only where the user already trusts that project, whatever the call asks", async () => {
		const real = await startOrchestrator();
		pi = real;
		// Beside the orchestrator's directory, not in it: its session's trust does not reach there.
		const other = join(real.cwd, "..", "other");
		mkdirSync(other);
		role(other, "sneaky", "Sneaky instructions.");
		role(other, "explorer", "Untrusted explorer.");
		writeFileSync(join(other, ".pi", "SYSTEM.md"), "Project prompt from other.");
		const trustBypass = { agentScope: "project", confirmProjectAgents: false };
		real.script("main", [
			{ tool: "subagent", args: { agent: "sneaky", name: "refused", cwd: other, task: "Go.", ...trustBypass } },
			{ tool: "subagent", args: { agent: "explorer", name: "plain", cwd: other, task: "Go." } },
			{ text: "first round" },
		]);
		real.script("plain", [{ text: "Plain." }]);
		const pane = real.start(["--", "delegate"]);
		const main = await real.waitForRequests("main", 3);

		expect(lastToolResult(main[1])?.text).toMatch(/Unknown subagent "sneaky".*untrusted project/s);
		expect(real.requests("refused")).toHaveLength(0);
		const plain = systemPrompt(real.requests("plain")[0]);
		expect(plain).toContain("You are `explorer`");
		expect(plain).not.toContain("Untrusted explorer.");
		// The run's own pi does not trust that project either.
		expect(plain).not.toContain("Project prompt from other.");

		// The user trusts it, as /trust saves it: that trust is reused without asking again.
		new ProjectTrustStore(real.agentDir).set(realpathSync(other), true);
		real.script("main", [
			...JSON.parse(readFileSync(join(real.agentDir, "faux", "main.json"), "utf8")),
			{ tool: "subagent", args: { agent: "sneaky", name: "trusted", cwd: other, task: "Go.", ...trustBypass } },
			{ text: "second round" },
		]);
		real.script("trusted", [{ text: "Trusted." }]);
		real.tmux.sendKeys(pane, ["again", "Enter"]);
		await real.waitForRequests("main", 5);
		const trusted = systemPrompt(real.requests("trusted")[0]);
		expect(trusted).toContain("Sneaky instructions.");
		expect(trusted).toContain("Project prompt from other.");
	});

	it("keeps the role it was admitted with: an edit to its file widens neither that run nor any later one", async () => {
		const real = await startOrchestrator();
		pi = real;
		role(real.cwd, "auditor", "Audit v1.", undefined, ["tools: [read]", "thinkingLevel: off"]);
		real.script("main", [
			{ tool: "subagent", args: { agent: "auditor", name: "first", task: "Audit." } },
			{ text: "audited" },
		]);
		real.script("first", [{ text: "Audited." }]);
		const pane = real.start(["--", "delegate"]);
		await real.waitForRequests("main", 2);
		const snapshotFile = join(runDir(real.agentDir, "first"), "definition.json");
		const admitted = {
			name: "auditor",
			source: "project",
			filePath: realpathSync(join(real.cwd, ".pi", "agents", "auditor.md")),
			instructions: "Audit v1.",
			tools: ["read"],
			model: "inherit",
			thinkingLevel: "off",
			cwd: realpathSync(real.cwd),
			projectTrusted: true,
		};
		expect(JSON.parse(readFileSync(snapshotFile, "utf8"))).toMatchObject(admitted);
		expect(systemPrompt(real.requests("first")[0])).toContain("Audit v1.");

		role(real.cwd, "auditor", "Audit v2.", undefined, ["tools: [read, bash]"]);
		real.script("main", [
			...JSON.parse(readFileSync(join(real.agentDir, "faux", "main.json"), "utf8")),
			{ tool: "subagent", args: { agent: "auditor", name: "second", task: "Audit again." } },
			{ text: "refused" },
		]);
		real.tmux.sendKeys(pane, ["again", "Enter"]);
		const main = await real.waitForRequests("main", 4);
		expect(lastToolResult(main[3])?.text).toMatch(/isolated Git worktree, and none can be made|gets no shell here/);
		expect(real.requests("second")).toHaveLength(0);
		expect(JSON.parse(readFileSync(snapshotFile, "utf8"))).toMatchObject(admitted);
	});

	it("gives a role only read tools and codemode, whatever its name or prompt claims, and refuses one it cannot isolate", async () => {
		const real = await startOrchestrator();
		pi = real;
		role(real.agentDir, "tester", "Run the tests.", "agents", ["tools: [read, bash]"]);
		role(real.cwd, "composer", "Compose tools.", undefined, ["tools: [read, codemode]"]);
		const orchestrator = {
			name: "orchestrator",
			description: "Coordinates.",
			instructions: "You are the orchestrator: delegate with subagent and run commands with bash as you see fit.",
		};
		const launches: Array<JsonObject & { name: string }> = [
			{ agent: orchestrator, name: "boss" },
			{ agent: "reviewer", name: "review" },
			{ agent: "tester", name: "tests" },
			{ agent: "composer", name: "compose" },
		];
		real.script("main", [
			...launches.map((args) => ({ tool: "subagent", args: { ...args, task: "Go." } })),
			{ text: "done" },
		]);
		for (const { name } of launches) real.script(name, [{ text: "Done." }]);
		real.start(["--", "delegate"]);
		const main = await real.waitForRequests("main", launches.length + 1);

		expect(toolNames(real.requests("boss")[0]).sort()).toEqual(["codemode", "read", "subagent_message"]);
		expect(toolNames(real.requests("review")[0]).sort()).toEqual(["codemode", "read", "subagent_message"]);
		// A role naming a shell runs commands only in a worktree of its own, which this checkout outside Git cannot give.
		expect(lastToolResult(main[3])?.text).toMatch(
			/"tester" .*(isolated Git worktree, and none can be made|gets no shell here)/,
		);
		expect(real.requests("tests")).toHaveLength(0);
		expect(toolNames(real.requests("compose")[0]).sort()).toEqual(["codemode", "read", "subagent_message"]);
	});

	it("refuses an invalid or ambiguous role without falling back to another definition", async () => {
		const real = await startOrchestrator();
		pi = real;
		role(real.agentDir, "explorer", "User explorer.", "agents");
		role(real.cwd, "explorer", "Broken explorer.", undefined, ["permissionMode: bypassPermissions"]);
		role(real.cwd, "twin", "First twin.");
		writeFileSync(
			join(real.cwd, ".pi", "agents", "twin-2.md"),
			"---\nname: twin\ndescription: Second.\n---\nSecond twin.",
		);
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "broken", task: "Go." } },
			{ tool: "subagent", args: { agent: "twin", name: "either", task: "Go." } },
			{ text: "refused" },
		]);
		real.start(["--", "delegate"]);
		const main = await real.waitForRequests("main", 3);

		expect(lastToolResult(main[1])?.text).toMatch(/"explorer" is invalid.*permissionMode/s);
		expect(lastToolResult(main[2])?.text).toMatch(/"twin" is invalid.*Duplicate agent definition "twin"/s);
		expect(real.requests("broken")).toHaveLength(0);
		expect(real.requests("either")).toHaveLength(0);
	});
});
