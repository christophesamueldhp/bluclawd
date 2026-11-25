import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BackgroundJobRegistry } from "../ext/background-bash/background-bash.ts";
import { monitorShellExec } from "../ext/background-bash/monitor-shell.ts";
import { agentDirs, runtimeConfig } from "../ext/sandbox/config.ts";
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

		async function run(command: string, env?: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
			let output = "";
			const { exitCode } = await exec(command, dir, {
				env,
				onData: (data) => {
					output += data.toString();
				},
			});
			return { code: exitCode, output };
		}

		async function start(): Promise<void> {
			const config = runtimeConfig(
				{
					allowedDomains: [],
					allowWrite: [],
					denyRead: [],
					denyWrite: [],
					denyUnixSockets: [],
					credentialFiles: [],
					written: {
						credentials: { envVars: [{ name: "BLUCLAWD_IT_TOKEN", mode: "deny" }] },
						filesystem: { allowRead: [agentDir] },
					},
				},
				["Read(**/.env*)", "Read(*.txt)"],
				dir,
				homedir(),
				tmpdir(),
				[],
				agentDirs(),
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
			mkdirSync(join(agentDir, "bluclawd"));
			writeFileSync(join(agentDir, "auth.json"), "test-pi-auth\n");
			writeFileSync(join(agentDir, "bluclawd", "accounts.json"), "test-account-vault\n");
			process.env.PI_CODING_AGENT_DIR = agentDir;
			setSandboxEngine(undefined);
			await start();
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

		it("keeps task output readable and refuses write access inside a writable directory", async () => {
			const home = join(dir, "task-home[fixture]");
			const previousHome = process.env.HOME;
			mkdirSync(home);
			process.env.HOME = home;
			try {
				await start();
				const registry = new BackgroundJobRegistry();
				const lines: string[] = [];
				const job = registry.start({
					command: "echo monitor-event; echo diagnostic >&2",
					cwd: dir,
					kind: "monitor",
					exec: wrapExec(
						monitorShellExec(() => undefined),
						() => undefined,
					),
					onLines: (batch) => lines.push(...batch),
				});
				const outputFile = job.outputFile;
				if (!outputFile) throw new Error("Monitor has no output file");
				await expect.poll(() => readFileSync(outputFile, "utf8")).toContain("[exited with code 0]");
				expect(lines).toContain("monitor-event");
				expect(lines).not.toContain("diagnostic");
				const env = { ...process.env, JOB_OUTPUT: outputFile };
				const cat = await run('cat "$JOB_OUTPUT"', env);
				expect(cat.code).toBe(0);
				expect(cat.output).toContain("monitor-event\n");
				expect(cat.output).toContain("diagnostic\n");
				const tail = await run('tail -n 1 "$JOB_OUTPUT"', env);
				expect(tail.code).toBe(0);
				expect(tail.output).toContain("[exited with code 0]");
				const writeAccess = await run(
					`node -e 'const fs = require("node:fs"); fs.closeSync(fs.openSync(process.env.JOB_OUTPUT, "r+"));'`,
					env,
				);
				expect(writeAccess.code).not.toBe(0);
				expect(writeAccess.output).toMatch(/EACCES|EROFS|EPERM/);
			} finally {
				if (previousHome === undefined) delete process.env.HOME;
				else process.env.HOME = previousHome;
				await start();
			}
		});

		it("denies reads of pi's auth file and bluclawd's saved accounts", async () => {
			const accounts = await run('cat "$PI_CODING_AGENT_DIR/bluclawd/accounts.json"');
			expect(accounts.code).not.toBe(0);
			expect(accounts.output).not.toContain("test-account-vault");
			const auth = await run('cat "$PI_CODING_AGENT_DIR/auth.json"');
			expect(auth.code).not.toBe(0);
			expect(auth.output).not.toContain("test-pi-auth");
		});

		it("unsets EXA_API_KEY only in sandboxed shells", async () => {
			vi.stubEnv("EXA_API_KEY", "test-exa-key");
			const command = `echo "\${EXA_API_KEY-unset}"`;
			expect(await run(command)).toMatchObject({ code: 0, output: expect.stringMatching(/^unset\n/) });
			expect(process.env.EXA_API_KEY).toBe("test-exa-key");
			await stopSandbox();
			try {
				expect(await run(command)).toEqual({ code: 0, output: "test-exa-key\n" });
			} finally {
				await start();
			}
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
