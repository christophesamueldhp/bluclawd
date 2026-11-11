/**
 * The orchestrator's sandboxed shell, for real, cannot connect to bluclawd's own sockets, the daemon's
 * `server.sock` and tmux's `tmux.sock`, whatever the user's Unix-socket settings allow (ADR-0012). macOS only:
 * on Linux the Unix-socket settings are ignored and the server directory is hidden instead.
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseSandbox, runtimeConfig, serverDirs } from "../ext/sandbox/config.ts";
import { setSandboxEngine, startSandbox, stopSandbox, wrapExec } from "../ext/sandbox/runtime.ts";

const supported =
	process.platform === "darwin" &&
	SandboxManager.isSupportedPlatform() &&
	SandboxManager.checkDependencies().errors.length === 0;

const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

const connect = (path: string) =>
	`${quote(process.execPath)} -e ${quote(`require("net").connect(${JSON.stringify(path)}).on("data", (d) => { process.stdout.write("CONNECTED " + d); process.exit(0); }).on("error", (e) => { process.stdout.write(e.code); process.exit(1); })`)}`;

describe.skipIf(!supported)("the orchestrator's shell and bluclawd's own sockets", () => {
	let root: string;
	let project: string;
	let home: string;
	let privateDir: string;
	let defaultDir: string;
	let dirs: string[];
	/** A socket of the user's own, outside both server directories. */
	let userSocket: string;
	const servers: Server[] = [];
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

	async function start(network: Record<string, unknown>): Promise<void> {
		const setting = parseSandbox({ enabled: true, network });
		if (setting.kind !== "on") throw new Error(setting.kind);
		const config = runtimeConfig(setting.settings, [], project, home, tmpdir(), dirs);
		expect(await startSandbox(config, async () => false)).toEqual({ kind: "ready" });
	}

	/** Every server socket refuses the shell, though each answers outside it; the user's own socket still answers. */
	async function expectOwnSocketsDenied(): Promise<void> {
		for (const dir of [privateDir, defaultDir]) {
			for (const name of ["server.sock", "tmux.sock"]) {
				const path = join(dir, name);
				const outside = await new Promise<string>((resolve) =>
					execFile("/bin/sh", ["-c", connect(path)], { encoding: "utf8" }, (_error, stdout) => resolve(stdout)),
				);
				expect(outside, path).toBe("CONNECTED hello\n");
				const result = await run(connect(path));
				expect(result.code, path).not.toBe(0);
				// srt may append the violations it logged.
				expect(result.output, path).toMatch(/^EPERM/);
			}
		}
		expect(await run(connect(userSocket))).toMatchObject({
			code: 0,
			output: expect.stringMatching(/^CONNECTED hello\n/),
		});
	}

	beforeAll(async () => {
		// Short, for macOS's 104-byte limit on a socket's path.
		root = realpathSync(mkdtempSync("/tmp/bcs-"));
		project = join(root, "project");
		home = join(root, "home");
		privateDir = join(root, "private", "server");
		defaultDir = join(home, ".pi", "server");
		userSocket = join(root, "user", "user.sock");
		for (const dir of [project, privateDir, defaultDir, join(root, "user")]) mkdirSync(dir, { recursive: true });
		for (const path of [
			join(privateDir, "server.sock"),
			join(privateDir, "tmux.sock"),
			join(defaultDir, "server.sock"),
			join(defaultDir, "tmux.sock"),
			userSocket,
		]) {
			const server = createServer((socket) => socket.end("hello\n"));
			await new Promise<void>((resolve) => server.listen(path, resolve));
			servers.push(server);
		}
		vi.stubEnv("HOME", home);
		vi.stubEnv("PI_SERVER_DIR", privateDir);
		dirs = serverDirs();
		// The sandbox itself starts under the real home.
		vi.unstubAllEnvs();
		setSandboxEngine(undefined);
	});

	afterAll(async () => {
		await stopSandbox();
		for (const server of servers) server.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("cannot connect to either server directory's, with every Unix socket allowed", async () => {
		await start({ allowAllUnixSockets: true });
		await expectOwnSocketsDenied();
	});

	it("cannot, with an allowUnixSockets entry above both server directories", async () => {
		await start({ allowUnixSockets: [root] });
		await expectOwnSocketsDenied();
	});
});
