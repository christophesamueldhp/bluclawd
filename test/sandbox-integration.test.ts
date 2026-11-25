import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runtimeConfig } from "../ext/sandbox/config.ts";
import { networkAsker } from "../ext/sandbox/index.ts";
import { setSandboxEngine, startSandbox, stopSandbox, wrapExec } from "../ext/sandbox/runtime.ts";
import { beatsFromNow, descendantCommand, leavingBehind } from "./helpers/heartbeats.ts";

const supported =
	process.platform !== "win32" &&
	SandboxManager.isSupportedPlatform() &&
	SandboxManager.checkDependencies().errors.length === 0;

describe.skipIf(!supported)(
	"the sandbox, for real",
	() => {
		let dir: string;
		let agentDir: string;
		const probe = join(homedir(), `.bluclawd-sandbox-probe-${process.pid}`);
		const confirm = vi.fn(async () => false);
		const exec = wrapExec(
			(command, cwd, options) => createLocalBashOperations().exec(command, cwd, options),
			() => undefined,
		);

		async function run(command: string): Promise<{ code: number | null; output: string }> {
			let output = "";
			const { exitCode } = await exec(command, dir, {
				onData: (data) => {
					output += data.toString();
				},
			});
			return { code: exitCode, output };
		}

		async function configure(allowWrite: string[] = []) {
			const config = runtimeConfig(
				{
					allowedDomains: [],
					allowWrite,
					denyRead: [],
					denyWrite: [],
					denyUnixSockets: [],
					credentialFiles: [],
					written: { credentials: { envVars: [{ name: "BLUCLAWD_IT_TOKEN", mode: "deny" }] } },
				},
				["Read(**/.env*)", "Read(*.txt)"],
				dir,
				homedir(),
				tmpdir(),
				[],
				[],
			);
			const asker = networkAsker(() => ({ hasUI: true, ui: { confirm } }) as never);
			expect(await startSandbox(config, asker.ask)).toEqual({ kind: "ready" });
		}

		beforeAll(async () => {
			dir = realpathSync(mkdtempSync(join(tmpdir(), "bluclawd-sandbox-it-")));
			writeFileSync(join(dir, ".env"), "SECRET=hunter2\n");
			writeFileSync(join(dir, "app.ts"), "const SECRET = process.env.SECRET;\n");
			writeFileSync(join(dir, "draft.txt"), "draft\n");
			process.env.BLUCLAWD_IT_TOKEN = "hunter3";
			agentDir = mkdtempSync(join(tmpdir(), "bluclawd-sandbox-it-agent-"));
			process.env.PI_CODING_AGENT_DIR = agentDir;
			setSandboxEngine(undefined);
			await configure();
		}, 60_000);

		afterAll(async () => {
			await stopSandbox();
			delete process.env.BLUCLAWD_IT_TOKEN;
			delete process.env.PI_CODING_AGENT_DIR;
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(dir, { recursive: true, force: true });
			rmSync(probe, { force: true });
		});

		it("keeps .env from a search that never names it", async () => {
			const { output } = await run("grep -r SECRET .");
			expect(output).toContain("app.ts");
			expect(output).not.toContain("hunter2");
		});

		it("keeps .env from a script that opens it", async () => {
			const { code, output } = await run(`node -e 'console.log(require("fs").readFileSync(".env","utf8"))'`);
			expect(code).not.toBe(0);
			expect(output).not.toContain("hunter2");
		});

		it("applies a leading wildcard to paths in the working directory", async () => {
			expect((await run("cat ./draft.txt")).code).not.toBe(0);
			expect((await run("cat ./app.ts")).code).toBe(0);
		});

		it("refuses to create a project extension in a fresh working directory", async () => {
			expect(existsSync(join(dir, ".pi"))).toBe(false);
			const result = await run("mkdir -p .pi/extensions && touch .pi/extensions/x.ts");
			expect(result.code).not.toBe(0);
			expect(existsSync(join(dir, ".pi/extensions/x.ts"))).toBe(false);
		});

		it.skipIf(process.platform !== "darwin")(
			"protects case variants on a case-insensitive volume",
			async (context) => {
				if (!existsSync(join(dir, "APP.TS"))) context.skip();
				expect(existsSync(join(dir, ".pi"))).toBe(false);
				expect((await run("mkdir -p .PI/extensions && touch .PI/extensions/case-fixture")).code).not.toBe(0);
				expect(existsSync(join(dir, ".pi/extensions/case-fixture"))).toBe(false);
			},
		);

		it.each([
			[".pi", ".pi/extensions/fixture"],
			[".agents", ".agents/fixture"],
			[".git/hooks", ".git/hooks/fixture"],
			[".git/config", ".git/config"],
			[".vscode", ".vscode/fixture"],
			[".idea", ".idea/fixture"],
			[".claude", ".claude/fixture"],
			[".mcp.json", ".mcp.json"],
		])("blocks writes and renames into %s before and after it exists", async (protectedPath, target) => {
			const path = join(dir, target);
			mkdirSync(join(dir, dirname(protectedPath)), { recursive: true });
			expect(existsSync(join(dir, protectedPath))).toBe(false);
			expect((await run("printf allowed > move-source")).code).toBe(0);
			expect((await run(`mv move-source ${protectedPath}`)).code).not.toBe(0);
			expect((await run(`mkdir -p ${dirname(target)} && printf new > ${target}`)).code).not.toBe(0);
			expect(existsSync(path)).toBe(false);

			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, "original");
			expect((await run(`printf new > ${target}`)).code).not.toBe(0);
			expect((await run(`mv move-source ${target}`)).code).not.toBe(0);
			expect(readFileSync(path, "utf8")).toBe("original");
			expect(readFileSync(join(dir, "move-source"), "utf8")).toBe("allowed");
		});

		it("releases an exact global path and keeps other paths protected", async () => {
			try {
				await configure([".", "./.agents/"]);
				expect((await run("mkdir -p .agents && printf allowed > .agents/released-fixture")).code).toBe(0);
				expect((await run("mkdir -p .pi && printf denied > .pi/other-fixture")).code).not.toBe(0);
				expect(readFileSync(join(dir, ".agents/released-fixture"), "utf8")).toBe("allowed");
				expect(existsSync(join(dir, ".pi/other-fixture"))).toBe(false);
			} finally {
				await configure();
			}
		});

		it("appends to .env in the project (not on Linux), but cannot write outside it", async () => {
			const append = await run("echo ADDED=1 >> .env");
			if (process.platform === "linux") {
				// bubblewrap hides a Read-denied file behind a read-only /dev/null, which refuses writes too.
				expect(append.code).not.toBe(0);
				expect(append.output).toContain(".env: Permission denied");
				expect(readFileSync(join(dir, ".env"), "utf8")).toBe("SECRET=hunter2\n");
			} else {
				expect(append.code).toBe(0);
				expect(readFileSync(join(dir, ".env"), "utf8")).toContain("ADDED=1");
			}
			const outside = await run(`echo x > ${probe}`);
			expect(outside.code).not.toBe(0);
			expect(existsSync(probe)).toBe(false);
		});

		it("hides an environment variable srt's credentials setting denies", async () => {
			const { output } = await run('echo "token=$BLUCLAWD_IT_TOKEN"');
			expect(output).toContain("token=");
			expect(output).not.toContain("hunter3");
		});

		it("refuses a host the user did not allow", async () => {
			const { output } = await run("curl -sS -m 10 https://example.com -o /dev/null -w '%{http_code}'");
			expect(output).toContain("403");
		});

		it("ends a descendant the command detaches and leaves running when it exits", async () => {
			const heartbeats = join(dir, "heartbeat.jsonl");
			const lifetimeMs = 3000;
			const command = descendantCommand("detached", heartbeats, "sandbox-it-probe", lifetimeMs);
			const started = Date.now();
			try {
				await run(leavingBehind(command, heartbeats));
				const result = await beatsFromNow(heartbeats);
				expect(result.started).toBe(true);
				expect(result.stillWriting).toEqual([]);
			} finally {
				await new Promise((resolve) => setTimeout(resolve, Math.max(0, started + lifetimeMs + 500 - Date.now())));
			}
		});
	},
	120_000,
);
