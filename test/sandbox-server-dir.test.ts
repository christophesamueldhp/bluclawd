/**
 * The orchestrator's sandboxed shell, for real, cannot read bluclawd's server directories: the one this pi resolves
 * and the default one, whatever the user's `allowRead` names (ADR-0012). macOS only: Linux hiding is untested here.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runtimeConfig, type SandboxSettings, serverDirs } from "../ext/sandbox/config.ts";
import { setSandboxEngine, startSandbox, stopSandbox, wrapExec } from "../ext/sandbox/runtime.ts";

const supported =
	process.platform === "darwin" &&
	SandboxManager.isSupportedPlatform() &&
	SandboxManager.checkDependencies().errors.length === 0;

const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

describe.skipIf(!supported)("the orchestrator's shell and bluclawd's server directories", () => {
	let root: string;
	let project: string;
	let home: string;
	/** The private PI_SERVER_DIR as written: through tmpdir's link, and made only after the sandbox starts. */
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

	async function start(settings: Partial<SandboxSettings>): Promise<void> {
		const config = runtimeConfig(
			{ allowedDomains: [], allowWrite: [], denyRead: [], denyWrite: [], written: {}, ...settings },
			[],
			project,
			homedir(),
			tmpdir(),
			dirs,
		);
		expect(await startSandbox(config, async () => false)).toEqual({ kind: "ready" });
	}

	/** Neither server directory can be listed, nor a file in it read; outside the sandbox both can. */
	async function expectServerDirsHidden(): Promise<void> {
		for (const dir of [privateDir, defaultDir]) {
			const outside = execFileSync("/bin/sh", ["-c", `ls ${quote(dir)} && cat ${quote(join(dir, "remote.json"))}`], {
				encoding: "utf8",
			});
			expect(outside).toContain("SERVER-SECRET");
			for (const command of [`ls ${quote(dir)}`, `cat ${quote(join(dir, "remote.json"))}`]) {
				const result = await run(command);
				expect(result.code, command).not.toBe(0);
				expect(result.output, command).not.toMatch(/^remote\.json$|SERVER-SECRET/m);
			}
		}
		// The shell itself works, and reads next to them; srt may append the violations it logged.
		expect(await run(`cat ${quote(join(root, "beside.txt"))}`)).toMatchObject({
			code: 0,
			output: expect.stringMatching(/^BESIDE\n/),
		});
	}

	beforeAll(() => {
		const spelled = mkdtempSync(join(tmpdir(), "bluclawd-server-dir-"));
		root = realpathSync(spelled);
		project = join(root, "project");
		home = join(root, "home");
		privateDir = join(spelled, "private", "server");
		defaultDir = join(home, ".pi", "server");
		mkdirSync(project);
		mkdirSync(defaultDir, { recursive: true });
		writeFileSync(join(defaultDir, "remote.json"), "SERVER-SECRET\n");
		writeFileSync(join(root, "beside.txt"), "BESIDE\n");
		writeFileSync(join(root, "user-credential"), "USER-SECRET\n");
		const saved = { HOME: process.env.HOME, PI_SERVER_DIR: process.env.PI_SERVER_DIR };
		process.env.HOME = home;
		process.env.PI_SERVER_DIR = privateDir;
		try {
			dirs = serverDirs();
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
		setSandboxEngine(undefined);
	});

	afterAll(async () => {
		await stopSandbox();
		rmSync(root, { recursive: true, force: true });
	});

	it("cannot list or read either one, the private one made after the sandbox started", async () => {
		await start({});
		mkdirSync(privateDir, { recursive: true });
		writeFileSync(join(privateDir, "remote.json"), "SERVER-SECRET\n");
		await expectServerDirsHidden();
	});

	it("cannot, with an allowRead naming each of them", async () => {
		await start({
			denyRead: [root],
			written: { filesystem: { allowRead: [project, join(root, "beside.txt"), privateDir, defaultDir] } },
		});
		await expectServerDirsHidden();
	});

	it("cannot, with an allowRead naming a directory above them", async () => {
		await start({
			denyRead: [root],
			written: { filesystem: { allowRead: [project, join(root, "beside.txt"), join(privateDir, ".."), home] } },
		});
		await expectServerDirsHidden();
	});

	it("still keeps what the user's own credentials setting denies", async () => {
		const credential = join(root, "user-credential");
		await start({ written: { credentials: { files: [{ path: credential, mode: "deny" }] } } });
		const result = await run(`cat ${quote(credential)}`);
		expect(result.code).not.toBe(0);
		expect(result.output).not.toContain("USER-SECRET");
		await expectServerDirsHidden();
	});
});
