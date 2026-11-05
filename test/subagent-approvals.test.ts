import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { conversation, type FauxRequest, hasTmux, type RealPi, startRealPi, systemPrompt } from "./helpers/real-pi.ts";
import { waitFor } from "./helpers/wait-for.ts";

/** The text of every message the model was given, the reminder's and the Reports' included. */
const said = (request: FauxRequest) => conversation(request).map((message) => message.text);

/** A panel row's status cell, after its name, agent and model. */
const rowStatus = (screen: string, name: string) =>
	screen.match(new RegExp(`${name}\\s+\\S+\\s+\\S+\\s+(working|idle|needs input|running)`))?.[1];

/** Adds `settings` to the global settings every pane reads. */
function addSettings(real: RealPi, settings: Record<string, unknown>): void {
	const file = join(real.agentDir, "settings.json");
	writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...settings }));
}

describe.skipIf(!hasTmux)("a run's state, as its orchestrator sees it", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	it("an idle run is not waited for: its row says idle, and neither the title nor the reminder counts it", async () => {
		const real = await startRealPi();
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "probe-run", task: "Look around.", background: true } },
			{ text: "waiting for probe-run" },
			{ text: "read the report" },
		]);
		real.script("probe-run", [{ text: "First look." }]);
		const orchestrator = real.start(["--", "delegate the look"]);
		const screen = () => real.tmux.capture(orchestrator, 50).join("\n");

		const woken = (await real.waitForRequests("main", 3))[2];
		expect(said(woken).some((text) => text.includes("First look."))).toBe(true);
		expect(said(woken).some((text) => text.startsWith("Subagents still active"))).toBe(false);
		await waitFor(() => expect(rowStatus(screen(), "probe-run")).toBe("idle"));
		expect(screen()).not.toContain("waiting for 1 subagent");
	});
});

const sandboxRuns =
	process.platform !== "win32" &&
	SandboxManager.isSupportedPlatform() &&
	SandboxManager.checkDependencies().errors.length === 0;

describe.skipIf(!hasTmux || !sandboxRuns)("an approval a run needs", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	it("asks in the run's own session; meanwhile its row needs input and the orchestrator is told, then it works on", async () => {
		const real = await startRealPi({ extensions: ["sandbox", "background-bash", "subagents", "agent-view"] });
		pi = real;
		addSettings(real, { sandbox: { enabled: true } });
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "probe-run", task: "Fetch a page.", background: true } },
			{ text: "waiting for probe-run" },
			{ text: "read the report" },
		]);
		real.script("probe-run", [
			{ tool: "bash", args: { command: "curl -s -o /dev/null --max-time 60 https://example.net; sleep 5" } },
			{ text: "Could not fetch it." },
		]);
		const orchestrator = real.start(["--", "delegate the fetch"]);
		const screen = () => real.tmux.capture(orchestrator, 50).join("\n");
		await real.waitForRequests("probe-run", 1);
		const runPane = (await real.rows()).find((row) => row.label === "probe-run")?.pane ?? "";

		await waitFor(() => expect(real.tmux.capture(runPane, 50).join("\n")).toContain("Network access"));
		await waitFor(() => expect(rowStatus(screen(), "probe-run")).toBe("needs input"));
		// Kept in its session as a message, which may wrap.
		await waitFor(() =>
			expect(screen().replace(/\s+/g, " ")).toMatch(
				/Subagent "probe-run" \(sub_[0-9a-f-]+\) needs input: Network access\. Open it to answer\./,
			),
		);
		expect(screen()).not.toContain("Allow the model's commands");
		expect(screen()).not.toContain("waiting for 1 subagent");

		real.tmux.sendKeys(runPane, ["Down", "Enter"]);
		await waitFor(() => expect(rowStatus(screen(), "probe-run")).toBe("working"));
		await real.waitForRequests("main", 3);
		await waitFor(() => expect(rowStatus(screen(), "probe-run")).toBe("idle"));
	});
});

describe.skipIf(!hasTmux)("a run's trust", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	/** An orchestrator in a project with a skill of its own, trusted or not for this session only, whose
	 *  model launches `probe-run`; the trust mode asks about any project not yet decided. */
	async function launchIn(trust: "--approve" | "--no-approve") {
		const real = await startRealPi();
		pi = real;
		addSettings(real, { defaultProjectTrust: "ask" });
		const skill = join(real.cwd, ".pi", "skills", "project-rules");
		mkdirSync(skill, { recursive: true });
		writeFileSync(
			join(skill, "SKILL.md"),
			"---\nname: project-rules\ndescription: The rules of this project.\n---\nFollow them.\n",
		);
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "probe-run", task: "Look around." } },
			{ text: "done" },
		]);
		real.script("probe-run", [{ text: "Looked." }]);
		real.start([trust, "--", "delegate the look"]);
		return real;
	}

	it("a run in a project its orchestrator trusts is trusted, without asking", async () => {
		const real = await launchIn("--approve");
		const [asked] = await real.waitForRequests("probe-run", 1);
		expect(systemPrompt(asked)).toContain("The rules of this project.");
		expect(systemPrompt(real.requests("main")[0])).toContain("The rules of this project.");
	});

	it("a run in a project its orchestrator does not trust is not trusted, without asking", async () => {
		const real = await launchIn("--no-approve");
		const [asked] = await real.waitForRequests("probe-run", 1);
		expect(systemPrompt(asked)).not.toContain("The rules of this project.");
	});
});
