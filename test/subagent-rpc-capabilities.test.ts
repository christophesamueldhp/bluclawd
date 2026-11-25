import { mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
import { storedRuns } from "./helpers/run-files.ts";

const PROBE = fileURLToPath(new URL("./fixtures/real-pi/probe-tools.ts", import.meta.url));

const lastToolResult = (request: FauxRequest) =>
	conversation(request)
		.filter((message) => message.role === "toolResult")
		.at(-1);

function runNames(agentDir: string): (string | undefined)[] {
	return storedRuns(agentDir).map(({ record }) => record.name);
}

function addSettings(real: RealPi, added: Record<string, unknown>): void {
	const path = join(real.agentDir, "settings.json");
	writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...added }));
}

async function startOrchestrator(extensions: string[] = []): Promise<RealPi> {
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
		expect(toolNames(look[0]).sort()).toEqual(["codemode", "read", "subagent_message"]);
		expect(lastToolResult(look[1])).toMatchObject({ toolName: "codemode" });
		expect(lastToolResult(look[1])?.text).toContain("ALPHA|BETA|undefined");
	});

	it("gives an explorer no write, shell, subagent or extension tool, called directly, nested or found", async () => {
		const real = await startOrchestrator([PROBE]);
		pi = real;
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
		expect(toolNames(look[0]).sort()).toEqual(["codemode", "read", "subagent_message"]);
		const script = lastToolResult(look[1])?.text ?? "";
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
		expect(toolNames(look[0]).sort()).toEqual(["codemode", "grep", "read", "subagent_message"]);
		expect(lastToolResult(look[1])?.text).toBe("token FINE\n");
		for (const step of [2, 3, 4, 5]) expect(lastToolResult(look[step])?.text).toMatch(/Blocked by permission rule/);
		expect(lastToolResult(look[6])?.text).toContain("FINE");
		const nested = lastToolResult(look[7])?.text ?? "";
		expect(nested).toContain("ok.txt: token FINE");
		expect(nested.match(/Blocked by permission rule/g)).toHaveLength(4);
		expect(JSON.stringify(look)).not.toContain("SECRET-");
	});

	it.each([
		["on RPC", false],
		["in a pane", true],
	])(
		"keeps a run %s from the credentials in the user's home and pi's own, by path or through a link, though no deny rule names them",
		async (_, runsInPanes) => {
			vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", FAUX);
			const real = await startRealPi({ runsInPanes });
			pi = real;
			const home = join(dirname(real.cwd), "home");
			const files: Record<string, string> = {
				".ssh/id_ed25519": "SECRET-SSH",
				"dotfiles/aws/credentials": "SECRET-AWS",
				".config/gh/hosts.yml": "SECRET-GH",
				".netrc": "SECRET-NETRC",
				".docker/config.json": "SECRET-DOCKER",
				"Library/Keychains/login.keychain-db": "SECRET-KEYCHAIN",
				".gitconfig": "FINE",
			};
			for (const [path, text] of Object.entries(files)) {
				mkdirSync(dirname(join(home, path)), { recursive: true });
				writeFileSync(join(home, path), `token ${text}\n`);
			}
			symlinkSync(join(home, "dotfiles", "aws"), join(home, ".aws"));
			symlinkSync(join(home, ".ssh"), join(real.cwd, "linked-ssh"));
			writeFileSync(join(real.agentDir, "models.json"), '{"providers":{}}\n');
			writeFileSync(join(dirname(real.cwd), "s", "remote.json"), '{"secret":"SECRET-REMOTE"}\n');
			addSettings(real, { defaultTools: ["+grep"] });
			real.script("main", [
				{ tool: "subagent", args: { agent: "explorer", name: "look", task: "Read the home directory." } },
				{ text: "done" },
			]);
			const denied = [
				".ssh/id_ed25519",
				".aws/credentials",
				"dotfiles/aws/credentials",
				".config/gh/hosts.yml",
				".netrc",
				".docker/config.json",
				"Library/Keychains/login.keychain-db",
			]
				.map((path) => join(home, path))
				.concat(
					join(real.cwd, "linked-ssh", "id_ed25519"),
					join(real.agentDir, "auth.json"),
					join(real.agentDir, "models.json"),
					join(dirname(real.cwd), "s", "remote.json"),
				);
			real.script("look", [
				...denied.map((path) => ({ tool: "read", args: { path } })),
				{ tool: "read", args: { path: join(home, ".gitconfig") } },
				{ tool: "grep", args: { pattern: "token", path: join(home, ".ssh") } },
				{ text: "Read what I could." },
			]);
			real.start(["--", "delegate"]);
			await real.waitForRequests("main", 2);

			const look = real.requests("look");
			expect(look).toHaveLength(denied.length + 3);
			denied.forEach((path, i) => {
				expect(lastToolResult(look[i + 1])?.text, path).toMatch(/Blocked by permission rule|Refused/);
			});
			expect(lastToolResult(look[denied.length + 1])?.text).toBe("token FINE\n");
			expect(lastToolResult(look[denied.length + 2])?.text).toMatch(/Blocked by permission rule/);
			expect(JSON.stringify(look)).not.toMatch(/SECRET-|"key":"faux"|api_key/);
		},
	);

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

		expect(toolNames(real.requests("look")[0])).toEqual(["read", "subagent_message"]);
		expect(lastToolResult(main[2])?.text).toMatch(/cannot give a child: codemode/);
		expect(real.requests("scripted")).toHaveLength(0);
	});
});
