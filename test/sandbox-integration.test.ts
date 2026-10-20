/**
 * The real sandbox runtime around a real shell: a Read-denied .env stays unreadable to any
 * command, writes stay in the project, and an unlisted host is refused. Skipped where `srt`
 * cannot run (native Windows, Linux without bubblewrap, socat or ripgrep).
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runtimeConfig } from "../ext/sandbox/config.ts";
import { setSandboxEngine, startSandbox, stopSandbox, wrapExec } from "../ext/sandbox/runtime.ts";

const supported =
	process.platform !== "win32" &&
	SandboxManager.isSupportedPlatform() &&
	SandboxManager.checkDependencies().errors.length === 0;

describe.skipIf(!supported)(
	"the sandbox, for real",
	() => {
		let dir: string;
		const probe = join(homedir(), `.bluclawd-sandbox-probe-${process.pid}`);
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

		beforeAll(async () => {
			dir = realpathSync(mkdtempSync(join(tmpdir(), "bluclawd-sandbox-it-")));
			writeFileSync(join(dir, ".env"), "SECRET=hunter2\n");
			writeFileSync(join(dir, "app.ts"), "const SECRET = process.env.SECRET;\n");
			process.env.BLUCLAWD_IT_TOKEN = "hunter3";
			setSandboxEngine(undefined);
			const config = runtimeConfig(
				{
					allowedDomains: [],
					allowWrite: [],
					denyRead: [],
					denyWrite: [],
					written: { credentials: { envVars: [{ name: "BLUCLAWD_IT_TOKEN", mode: "deny" }] } },
				},
				["Read(**/.env*)"],
				dir,
				homedir(),
				tmpdir(),
			);
			expect(await startSandbox(config, async () => false)).toEqual({ kind: "ready" });
		}, 60_000);

		afterAll(async () => {
			await stopSandbox();
			delete process.env.BLUCLAWD_IT_TOKEN;
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

		it("appends to .env in the project, but cannot write outside it", async () => {
			expect((await run("echo ADDED=1 >> .env")).code).toBe(0);
			expect(readFileSync(join(dir, ".env"), "utf8")).toContain("ADDED=1");
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
	},
	120_000,
);
