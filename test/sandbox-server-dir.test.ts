/**
 * The orchestrator's sandboxed shell, for real, cannot read bluclawd's server directories: the one this pi resolves
 * and the default one, whatever the user's `allowRead` names (ADR-0012). On Linux a directory is hidden behind an empty
 * one, and only when it exists as a command starts.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseSandbox, runtimeConfig, serverDirs } from "../ext/sandbox/config.ts";
import { setSandboxEngine, startSandbox, stopSandbox, wrapExec } from "../ext/sandbox/runtime.ts";
import { readinessMs } from "./helpers/heartbeats.ts";
import { waitFor } from "./helpers/wait-for.ts";

const supported =
	(process.platform === "darwin" || process.platform === "linux") &&
	SandboxManager.isSupportedPlatform() &&
	SandboxManager.checkDependencies().errors.length === 0;

const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

describe.skipIf(!supported)("the orchestrator's shell and bluclawd's server directories", () => {
	let root: string;
	let project: string;
	let home: string;
	/** The private PI_SERVER_DIR as written: through a link, and made only after the sandbox starts. */
	let privateDir: string;
	let defaultDir: string;
	let dirs: string[];
	const exec = wrapExec(
		(command, cwd, options) => createLocalBashOperations().exec(command, cwd, options),
		() => undefined,
	);

	async function run(command: string): Promise<{ code: number | null; output: string }> {
		let output = "";
		const { exitCode } = await exec(command, project, {
			onData: (data) => {
				output += data.toString();
			},
		});
		return { code: exitCode, output };
	}

	async function start(sandbox: Record<string, unknown>): Promise<void> {
		const setting = parseSandbox({ enabled: true, ...sandbox });
		if (setting.kind !== "on") throw new Error(setting.kind);
		const config = runtimeConfig(setting.settings, [], project, homedir(), tmpdir(), dirs);
		expect(await startSandbox(config, async () => false)).toEqual({ kind: "ready" });
	}

	/** Neither server directory's files can be listed or read; outside the sandbox both can. */
	async function expectServerDirsHidden(): Promise<void> {
		for (const dir of [privateDir, defaultDir]) {
			const file = join(dir, "remote.json");
			const outside = execFileSync("/bin/sh", ["-c", `ls ${quote(dir)} && cat ${quote(file)}`], {
				encoding: "utf8",
			});
			expect(outside).toContain("SERVER-SECRET");
			// macOS refuses the listing; Linux lists the empty directory that hides it.
			expect((await run(`ls ${quote(dir)}`)).output, dir).not.toMatch(/^remote\.json$/m);
			const read = await run(`cat ${quote(file)}`);
			expect(read.code, file).not.toBe(0);
			expect(read.output, file).not.toContain("SERVER-SECRET");
		}
		// The shell itself works, and reads next to them; srt may append the violations it logged.
		expect(await run(`cat ${quote(join(root, "beside.txt"))}`)).toMatchObject({
			code: 0,
			output: expect.stringMatching(/^BESIDE\n/),
		});
	}

	beforeAll(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "bluclawd-server-dir-")));
		project = join(root, "project");
		home = join(root, "home");
		privateDir = join(root, "link", "server");
		defaultDir = join(home, ".pi", "server");
		mkdirSync(project);
		mkdirSync(join(root, "private"));
		symlinkSync(join(root, "private"), join(root, "link"));
		mkdirSync(defaultDir, { recursive: true });
		writeFileSync(join(defaultDir, "remote.json"), "SERVER-SECRET\n");
		writeFileSync(join(root, "beside.txt"), "BESIDE\n");
		writeFileSync(join(root, "user-credential"), "USER-SECRET\n");
		vi.stubEnv("HOME", home);
		vi.stubEnv("PI_SERVER_DIR", privateDir);
		dirs = serverDirs();
		// The sandbox itself starts under the real home.
		vi.unstubAllEnvs();
		setSandboxEngine(undefined);
		// Linux hides only a directory that exists as a command starts, so its tests skip the one made later.
		if (process.platform === "linux") writePrivateDir();
	});

	function writePrivateDir(): void {
		mkdirSync(privateDir, { recursive: true });
		writeFileSync(join(privateDir, "remote.json"), "SERVER-SECRET\n");
	}

	afterAll(async () => {
		await stopSandbox();
		rmSync(root, { recursive: true, force: true });
	});

	// Not on Linux: there a directory made after a command started stays readable to it (#327).
	it.skipIf(process.platform === "linux")(
		"cannot list or read either one, the private one made while a command runs",
		async () => {
			await start({});
			const ready = join(project, "ready");
			const go = join(root, "go");
			// srt resolves its rules when it wraps a command, so this one's were set before the directory existed.
			const running = run(
				`touch ${quote(ready)}; for _ in $(seq ${Math.ceil(readinessMs / 100)}); do [ -e ${quote(go)} ] && echo GO && break; sleep 0.1; done; ls ${quote(privateDir)}; cat ${quote(join(privateDir, "remote.json"))}`,
			);
			await waitFor(() => existsSync(ready));
			writePrivateDir();
			writeFileSync(go, "");
			const { output } = await running;
			expect(output).toMatch(/^GO$/m);
			expect(output).not.toMatch(/^remote\.json$|SERVER-SECRET/m);
			await expectServerDirsHidden();
		},
	);

	it("cannot, with an allowRead naming each of them", async () => {
		await start({
			filesystem: { denyRead: [root], allowRead: [project, join(root, "beside.txt"), privateDir, defaultDir] },
		});
		await expectServerDirsHidden();
	});

	it("cannot, with an allowRead naming a directory above them", async () => {
		await start({
			filesystem: { denyRead: [root], allowRead: [project, join(root, "beside.txt"), join(root, "private"), home] },
		});
		await expectServerDirsHidden();
	});

	it("still keeps what the user's own credentials setting denies", async () => {
		const credential = join(root, "user-credential");
		await start({ credentials: { files: [{ path: credential, mode: "deny" }] } });
		const result = await run(`cat ${quote(credential)}`);
		expect(result.code).not.toBe(0);
		expect(result.output).not.toContain("USER-SECRET");
		await expectServerDirsHidden();
	});
});
