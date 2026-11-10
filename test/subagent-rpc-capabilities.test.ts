import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
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

const PROBE = fileURLToPath(new URL("./fixtures/real-pi/probe-tools.ts", import.meta.url));

/** The last tool result the model was given. */
const lastToolResult = (request: FauxRequest) =>
	conversation(request)
		.filter((message) => message.role === "toolResult")
		.at(-1);

/** The names of every run the orchestrators stored. */
function runNames(agentDir: string): string[] {
	const root = join(agentDir, "bluclawd", "subagents");
	return readdirSync(root).flatMap((session) =>
		readdirSync(join(root, session))
			.map((run) => join(root, session, run, "record.json"))
			.filter((record) => existsSync(record))
			.map((record) => JSON.parse(readFileSync(record, "utf8")).name),
	);
}

/** Merges `added` into the settings every pi of the test reads; before a pane starts, it holds for that pane. */
function addSettings(real: RealPi, added: Record<string, unknown>): void {
	const path = join(real.agentDir, "settings.json");
	writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...added }));
}

/** An orchestrator pane whose runs are RPC children, which load the faux provider and `extensions` besides. */
async function startOrchestrator(extensions: string[] = []): Promise<RealPi> {
	vi.stubEnv("BLUCLAWD_RPC_RUNS", "1");
	vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", [FAUX, ...extensions].join(":"));
	return startRealPi();
}

describe.skipIf(!hasTmux)("an RPC run's capabilities", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	it("lets an explorer compose its reads through codemode, without model helpers", async () => {
		const real = await startOrchestrator();
		pi = real;
		writeFileSync(join(real.cwd, "a.txt"), "ALPHA\n");
		writeFileSync(join(real.cwd, "b.txt"), "BETA\n");
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "look", task: "Read a.txt and b.txt." } },
			{ text: "done" },
		]);
		const code = [
			'const [a, b] = await Promise.all([tools.read({ path: "a.txt" }), tools.read({ path: "b.txt" })]);',
			'return [a.trim(), b.trim(), typeof models].join("|");',
		].join("\n");
		real.script("look", [{ tool: "codemode", args: { code } }, { text: "Read both." }]);
		real.start(["--", "delegate"]);
		await real.waitForRequests("main", 2);

		const look = real.requests("look");
		expect(look).toHaveLength(2);
		expect(toolNames(look[0]).sort()).toEqual(["codemode", "read"]);
		expect(lastToolResult(look[1])).toMatchObject({ toolName: "codemode" });
		expect(lastToolResult(look[1])?.text).toContain("ALPHA|BETA|undefined");
	});

	it("gives an explorer no write, shell, subagent or extension tool, called directly, nested or found", async () => {
		const real = await startOrchestrator([PROBE]);
		pi = real;
		// Defaults the user set for every pi, which a run's tools do not follow.
		addSettings(real, { defaultTools: ["+bash", "+write"] });
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "look", task: "Try everything." } },
			{ text: "done" },
		]);
		const code = [
			"const attempt = async (name, args) => {",
			'  try { await tools[name](args); return name + ": ran"; } catch (error) { return name + ": " + error.message.split("\\n")[0]; }',
			"};",
			"const tried = [];",
			'for (const [name, args] of [["mcp__probe__poke", {}], ["mcp__probe__late", {}], ["poke", {}], ["write", { path: "w.txt", content: "x" }], ["bash", { command: "touch b.txt" }], ["subagent", { agent: "explorer", task: "Nest." }]]) tried.push(await attempt(name, args));',
			'const found = (await searchTools("poke")).map((tool) => tool.name);',
			"return JSON.stringify({ all: ALL_TOOLS.map((tool) => tool.name).sort(), found, tried }, null, 1);",
		].join("\n");
		real.script("look", [
			{ tool: "codemode", args: { code } },
			{ tool: "mcp__probe__poke", args: {} },
			{ tool: "write", args: { path: "w.txt", content: "x" } },
			{ tool: "bash", args: { command: "touch b.txt" } },
			{ tool: "subagent", args: { agent: "explorer", name: "nested", task: "Nest." } },
			{ text: "Nothing worked." },
		]);
		real.start(["--", "delegate"]);
		await real.waitForRequests("main", 2);

		const look = real.requests("look");
		expect(look).toHaveLength(6);
		expect(toolNames(look[0]).sort()).toEqual(["codemode", "read"]);
		const script = lastToolResult(look[1])?.text ?? "";
		// Not even found: a tool named as MCP's is not one the run was given.
		expect(JSON.parse(script.slice(script.indexOf("{")))).toMatchObject({ all: ["read"], found: [] });
		for (const name of ["mcp__probe__poke", "mcp__probe__late", "poke", "write", "bash", "subagent"]) {
			expect(script).toMatch(new RegExp(`"${name}: (?!ran)`));
		}
		for (const [step, name] of [
			[2, "mcp__probe__poke"],
			[3, "write"],
			[4, "bash"],
			[5, "subagent"],
		] as const) {
			expect(lastToolResult(look[step])).toMatchObject({ toolName: name, text: expect.not.stringMatching(/hello/) });
		}
		// Nothing ran: no tool left its mark, no file was written, and no run but this one started.
		expect(readdirSync(real.cwd)).toEqual([]);
		expect(real.requests("nested")).toHaveLength(0);
		expect(runNames(real.agentDir)).toEqual(["look"]);
		expect(JSON.stringify([...real.requests("main"), ...look])).not.toContain("ran dry");
	});

	it("holds a run to its orchestrator's deny rules and its own workspace's, called directly or nested", async () => {
		const real = await startOrchestrator();
		pi = real;
		const pkg = join(real.cwd, "pkg");
		mkdirSync(join(pkg, ".pi"), { recursive: true });
		writeFileSync(join(pkg, "ok.txt"), "token FINE\n");
		writeFileSync(join(pkg, "secret.txt"), "token SECRET-S\n");
		writeFileSync(join(pkg, ".env"), "SECRET-E\n");
		writeFileSync(join(pkg, "inner.txt"), "token SECRET-I\n");
		symlinkSync("secret.txt", join(pkg, "alias.txt"));
		// The orchestrator's rules, relative to its own directory, and the rules of the run's trusted workspace.
		addSettings(real, { defaultTools: ["+grep"], permissions: { deny: ["Read(pkg/secret.txt)", "Read(*.env)"] } });
		writeFileSync(join(pkg, ".pi", "settings.json"), JSON.stringify({ permissions: { deny: ["Read(inner.txt)"] } }));
		new ProjectTrustStore(real.agentDir).set(realpathSync(pkg), true);
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "look", cwd: "pkg", task: "Read everything." } },
			{ text: "done" },
		]);
		const reads = ["ok.txt", "secret.txt", ".env", "alias.txt", "inner.txt"];
		const code = [
			"const out = [];",
			`for (const path of ${JSON.stringify(reads)}) {`,
			'  try { out.push(path + ": " + (await tools.read({ path }))); } catch (error) { out.push(path + ": " + error.message); }',
			"}",
			'out.push(await tools.grep({ pattern: "token", path: "." }));',
			'return out.join("\\n");',
		].join("\n");
		real.script("look", [
			...reads.map((path) => ({ tool: "read", args: { path } })),
			{ tool: "grep", args: { pattern: "token", path: "." } },
			{ tool: "codemode", args: { code } },
			{ text: "Read what I could." },
		]);
		real.start(["--", "delegate"]);
		await real.waitForRequests("main", 2);

		const look = real.requests("look");
		expect(look).toHaveLength(reads.length + 3);
		expect(toolNames(look[0]).sort()).toEqual(["codemode", "grep", "read"]);
		expect(lastToolResult(look[1])?.text).toBe("token FINE\n");
		for (const step of [2, 3, 4, 5]) expect(lastToolResult(look[step])?.text).toMatch(/Blocked by permission rule/);
		expect(lastToolResult(look[6])?.text).toContain("FINE");
		const nested = lastToolResult(look[7])?.text ?? "";
		expect(nested).toContain("ok.txt: token FINE");
		expect(nested.match(/Blocked by permission rule/g)).toHaveLength(4);
		// None of the denied files' contents reached the run's model, read directly, nested or by grep.
		expect(JSON.stringify(look)).not.toContain("SECRET-");
	});

	it("gives a run no codemode when its orchestrator's pi has none", async () => {
		const real = await startOrchestrator();
		pi = real;
		const { extensions } = JSON.parse(readFileSync(join(real.agentDir, "settings.json"), "utf8"));
		addSettings(real, { extensions: [...extensions, "-builtin:codemode"] });
		const scripted = {
			name: "scripted",
			description: "Scripts.",
			instructions: "Script.",
			tools: ["read", "codemode"],
		};
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "look", task: "Say hi." } },
			{ tool: "subagent", args: { agent: scripted, name: "scripted", task: "Script." } },
			{ text: "done" },
		]);
		real.script("look", [{ text: "Hi." }]);
		real.start(["--", "delegate"]);
		const main = await real.waitForRequests("main", 3);

		expect(toolNames(real.requests("look")[0])).toEqual(["read"]);
		expect(lastToolResult(main[2])?.text).toMatch(/cannot give a child: codemode/);
		expect(real.requests("scripted")).toHaveLength(0);
	});
});
