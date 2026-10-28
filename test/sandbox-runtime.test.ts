/**
 * The process-wide sandbox: starting it, and running a command through it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { runForSubagent } from "../ext/_shared/subagent-commands.ts";
import { backgroundBashJobs } from "../ext/background-bash/background-bash.ts";
import { createBackgroundBashTool } from "../ext/background-bash/bash-tool.ts";
import type { RuntimeConfig } from "../ext/sandbox/config.ts";
import { networkAsker } from "../ext/sandbox/index.ts";
import {
	type AskNetwork,
	type Exec,
	markSandboxUnavailable,
	runningCommands,
	type SandboxEngine,
	sandboxStatus,
	setSandboxEngine,
	startSandbox,
	stopSandbox,
	wrapExec,
} from "../ext/sandbox/runtime.ts";

const config: RuntimeConfig = {
	network: { allowedDomains: [], deniedDomains: [] },
	filesystem: { denyRead: ["/proj/**/.env*"], allowWrite: ["/proj"], denyWrite: [] },
};
const deny = async () => false;

function fakeEngine(overrides: Partial<SandboxEngine> = {}): SandboxEngine & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		isSupportedPlatform: () => true,
		checkDependencies: () => ({ errors: [], warnings: [] }),
		initialize: async () => {
			calls.push("initialize");
		},
		updateConfig: () => {
			calls.push("updateConfig");
		},
		wrapWithSandbox: async (command) => `sandboxed(${command})`,
		annotateStderrWithSandboxFailures: (_id, stderr) => stderr,
		cleanupAfterCommand: () => {
			calls.push("cleanup");
		},
		reset: async () => {
			calls.push("reset");
		},
		...overrides,
	};
}

function spyExec(): Exec & { commands: string[] } {
	const commands: string[] = [];
	return Object.assign(
		async (command: string) => {
			commands.push(command);
			return { exitCode: 0 };
		},
		{ commands },
	);
}

const options = () => ({ onData: vi.fn() });

afterEach(async () => {
	await stopSandbox();
	setSandboxEngine(undefined);
});

describe("startSandbox", () => {
	it("is ready when the engine starts, and updates the config on a second start", async () => {
		const engine = fakeEngine();
		setSandboxEngine(engine);
		expect(await startSandbox(config, deny, "darwin")).toEqual({ kind: "ready" });
		expect(await startSandbox(config, deny, "darwin")).toEqual({ kind: "ready" });
		expect(engine.calls).toEqual(["initialize", "updateConfig"]);
	});

	it("is unavailable on native Windows, pointing at WSL2", async () => {
		setSandboxEngine(fakeEngine());
		const status = await startSandbox(config, deny, "win32");
		expect(status.kind).toBe("unavailable");
		expect(status.kind === "unavailable" && status.reason).toContain("WSL2");
	});

	it("is unavailable with the missing dependencies and how to install them on Linux", async () => {
		setSandboxEngine(
			fakeEngine({ checkDependencies: () => ({ errors: ["bubblewrap (bwrap) not installed"], warnings: [] }) }),
		);
		const status = await startSandbox(config, deny, "linux");
		expect(status.kind === "unavailable" && status.reason).toContain("bubblewrap (bwrap) not installed");
		expect(status.kind === "unavailable" && status.reason).toContain("apt install bubblewrap socat ripgrep");
	});

	it("is unavailable when the platform is unsupported or the engine throws", async () => {
		setSandboxEngine(fakeEngine({ isSupportedPlatform: () => false }));
		expect(await startSandbox(config, deny, "freebsd")).toEqual({
			kind: "unavailable",
			reason: "the sandbox does not support freebsd",
		});
		await stopSandbox();
		setSandboxEngine(
			fakeEngine({
				initialize: async () => {
					throw new Error("proxy failed to start");
				},
			}),
		);
		expect(await startSandbox(config, deny, "darwin")).toEqual({
			kind: "unavailable",
			reason: "proxy failed to start",
		});
	});

	it("sends a network question to the latest start's ask", async () => {
		let given: AskNetwork | undefined;
		setSandboxEngine(
			fakeEngine({
				initialize: async (_config, ask) => {
					given = ask;
				},
			}),
		);
		const first = vi.fn(async () => false);
		const second = vi.fn(async () => true);
		await startSandbox(config, first, "darwin");
		await startSandbox(config, second, "darwin");
		expect(await given?.({ host: "example.com", port: 443 })).toBe(true);
		expect(first).not.toHaveBeenCalled();
	});

	it("applies the config of a start that follows markSandboxUnavailable, and still resets on stop", async () => {
		const engine = fakeEngine();
		setSandboxEngine(engine);
		await startSandbox(config, deny, "darwin");
		markSandboxUnavailable("invalid settings");
		expect(await startSandbox(config, deny, "darwin")).toEqual({ kind: "ready" });
		expect(engine.calls).toEqual(["initialize", "updateConfig"]);
		markSandboxUnavailable("invalid settings");
		await stopSandbox();
		expect(engine.calls).toContain("reset");
	});

	it("initializes once when two starts overlap", async () => {
		const engine = fakeEngine({
			initialize: async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				engine.calls.push("initialize");
			},
		});
		setSandboxEngine(engine);
		await Promise.all([startSandbox(config, deny, "darwin"), startSandbox(config, deny, "darwin")]);
		expect(engine.calls).toEqual(["initialize", "updateConfig"]);
	});

	it("stops: resets the engine and is off", async () => {
		const engine = fakeEngine();
		setSandboxEngine(engine);
		await startSandbox(config, deny, "darwin");
		await stopSandbox();
		expect(engine.calls).toContain("reset");
		expect(sandboxStatus()).toEqual({ kind: "off" });
	});
});

describe("wrapExec", () => {
	it("runs the command unchanged while the sandbox is off", async () => {
		const exec = spyExec();
		await wrapExec(exec, () => undefined)("ls", "/proj", options());
		expect(exec.commands).toEqual(["ls"]);
	});

	it("runs the wrapped command while ready, then cleans up", async () => {
		const engine = fakeEngine();
		setSandboxEngine(engine);
		await startSandbox(config, deny, "darwin");
		const exec = spyExec();
		expect(await wrapExec(exec, () => "/bin/zsh")("grep -r A .", "/proj", options())).toEqual({ exitCode: 0 });
		expect(exec.commands).toEqual(["sandboxed(grep -r A .)"]);
		expect(engine.calls).toContain("cleanup");
	});

	it("passes the shell, signal and a fresh id to the engine", async () => {
		const wrap = vi.fn(async (command: string) => `sandboxed(${command})`);
		setSandboxEngine(fakeEngine({ wrapWithSandbox: wrap }));
		await startSandbox(config, deny, "darwin");
		const signal = new AbortController().signal;
		await wrapExec(spyExec(), () => "/bin/zsh")("ls", "/proj", { ...options(), signal });
		await wrapExec(spyExec(), () => "/bin/zsh")("ls", "/proj", { ...options(), signal });
		const [first, second] = wrap.mock.calls as unknown as [
			string,
			string,
			undefined,
			AbortSignal,
			{ commandId: string; commandText: string },
		][];
		expect(first.slice(0, 4)).toEqual(["ls", "/bin/zsh", undefined, signal]);
		expect(first[4].commandText).toBe("ls");
		expect(first[4].commandId).not.toBe(second[4].commandId);
	});

	it("knows whom each running command runs for until it ends, even when it fails", async () => {
		setSandboxEngine(fakeEngine());
		await startSandbox(config, deny, "darwin");
		const api = { name: "api", reportNetworkDenied: vi.fn() };
		const seen: unknown[][] = [];
		const exec: Exec = async (command) => {
			seen.push([...runningCommands().values()]);
			if (command.includes("fail")) throw new Error("spawn failed");
			return { exitCode: 0 };
		};
		await runForSubagent(api, () => wrapExec(exec, () => undefined)("ls", "/proj", options()));
		await wrapExec(exec, () => undefined)("ls", "/proj", options());
		await expect(
			runForSubagent(api, () => wrapExec(exec, () => undefined)("fail", "/proj", options())),
		).rejects.toThrow("spawn failed");
		expect(seen).toEqual([[api], [undefined], [api]]);
		expect([...runningCommands().values()]).toEqual([]);
	});

	it("keeps a subagent's ownership for a command it starts in the background", async () => {
		setSandboxEngine(fakeEngine());
		await startSandbox(config, deny, "darwin");
		const api = { name: "api", reportNetworkDenied: vi.fn() };
		let seen: unknown;
		let background!: Promise<unknown>;
		const exec: Exec = async () => {
			seen = [...runningCommands().values()];
			return { exitCode: 0 };
		};
		// As run_in_background does: the tool call returns before the command starts.
		runForSubagent(api, () => {
			background = new Promise((resolve) => setTimeout(resolve, 5)).then(() =>
				wrapExec(exec, () => undefined)("sleep 1", "/proj", options()),
			);
		});
		await background;
		expect(seen).toEqual([api]);
	});

	it("keeps a subagent's ownership through the model's bash, in the foreground and in the background", async () => {
		setSandboxEngine(fakeEngine());
		await startSandbox(config, deny, "darwin");
		const api = { name: "api", reportNetworkDenied: vi.fn() };
		const seen: Record<string, unknown> = {};
		const bash = createBackgroundBashTool({
			cwd: "/proj",
			operations: {
				exec: wrapExec(
					async (command) => {
						seen[command] = [...runningCommands().values()];
						return { exitCode: 0 };
					},
					() => undefined,
				),
			},
			sendMessage: () => {},
			isMain: true,
		});
		const ctx = { sessionManager: { getSessionId: () => "main" } } as never;
		const run = (command: string, background = false) =>
			bash.execute("t", { command, run_in_background: background } as never, undefined, undefined, ctx);
		try {
			await runForSubagent(api, () => run("child-fg"));
			await runForSubagent(api, () => run("child-bg", true));
			await run("parent-fg");
			for (let i = 0; i < 200 && !("sandboxed(child-bg)" in seen); i++) await new Promise((r) => setTimeout(r, 5));
			expect(seen).toEqual({
				"sandboxed(child-fg)": [api],
				"sandboxed(child-bg)": [api],
				"sandboxed(parent-fg)": [undefined],
			});
		} finally {
			for (const job of backgroundBashJobs.list()) backgroundBashJobs.kill(job.id);
		}
	});

	it("attributes a network ask to the command that made it while orchestrator and subagent commands run together", async () => {
		let engineAsk!: AskNetwork;
		// As srt does: the wrapped command presents its id with each request, and can leave it out.
		setSandboxEngine(
			fakeEngine({
				initialize: async (_config, ask) => {
					engineAsk = ask;
				},
				wrapWithSandbox: async (command, _shell, _custom, _signal, { commandId }) =>
					JSON.stringify({ command, commandId }),
			}),
		);
		const confirm = vi.fn(async () => true);
		const asker = networkAsker(() => ({ hasUI: true, ui: { confirm } }) as never);
		await startSandbox(config, asker.ask, "darwin");
		const api = { name: "api", reportNetworkDenied: vi.fn() };
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const answers: Record<string, unknown> = {};
		const bash = createBackgroundBashTool({
			cwd: "/proj",
			operations: {
				exec: wrapExec(
					async (wrapped) => {
						const { command, commandId } = JSON.parse(wrapped);
						const [verb, host] = command.split(" ");
						if (verb === "wait-then-fetch") await gate;
						answers[command] = await engineAsk({
							host,
							port: 443,
							commandId: verb === "fetch-without-id" ? undefined : commandId,
						});
						return { exitCode: 0 };
					},
					() => undefined,
				),
			},
			sendMessage: () => {},
			isMain: true,
		});
		const ctx = { sessionManager: { getSessionId: () => "main" } } as never;
		const run = (command: string, background = false) =>
			bash.execute("t", { command, run_in_background: background } as never, undefined, undefined, ctx);
		const deniedToChild = { allow: false, reason: expect.stringMatching(/orchestrator/) };
		try {
			await run("wait-then-fetch parent.example", true);
			for (let i = 0; i < 200 && runningCommands().size === 0; i++) await new Promise((r) => setTimeout(r, 5));

			await runForSubagent(api, () => run("fetch registry.npmjs.org"));
			expect(answers["fetch registry.npmjs.org"]).toEqual(deniedToChild);
			expect(api.reportNetworkDenied).toHaveBeenLastCalledWith("registry.npmjs.org:443", ["api"]);

			await runForSubagent(api, () => run("fetch-without-id evil.example"));
			expect(answers["fetch-without-id evil.example"]).toEqual(deniedToChild);
			expect(api.reportNetworkDenied).toHaveBeenLastCalledWith("evil.example:443", ["api"]);
			expect(confirm).not.toHaveBeenCalled();

			await runForSubagent(api, () => run("wait-then-fetch child.example", true));
			for (let i = 0; i < 200 && runningCommands().size < 2; i++) await new Promise((r) => setTimeout(r, 5));
			release();
			for (let i = 0; i < 200 && Object.keys(answers).length < 4; i++) await new Promise((r) => setTimeout(r, 5));
			expect(answers["wait-then-fetch parent.example"]).toBe(true);
			expect(answers["wait-then-fetch child.example"]).toEqual(deniedToChild);
			expect(confirm).toHaveBeenCalledTimes(1);
			expect(confirm).toHaveBeenCalledWith("Network access", expect.stringContaining("parent.example:443"));
		} finally {
			for (const job of backgroundBashJobs.list()) backgroundBashJobs.kill(job.id);
		}
	});

	it("appends what the sandbox blocked to the output", async () => {
		setSandboxEngine(
			fakeEngine({
				annotateStderrWithSandboxFailures: (_id, stderr) =>
					`${stderr}\n<sandbox_violations>\ndeny file-read-data /proj/.env\n</sandbox_violations>`,
			}),
		);
		await startSandbox(config, deny, "darwin");
		const opts = options();
		await wrapExec(spyExec(), () => undefined)("cat .env", "/proj", opts);
		const written = opts.onData.mock.calls.map(([data]) => String(data)).join("");
		expect(written).toContain("deny file-read-data /proj/.env");
	});

	it("refuses to run anything while unavailable", async () => {
		markSandboxUnavailable("bubblewrap (bwrap) not installed");
		const exec = spyExec();
		await expect(wrapExec(exec, () => undefined)("ls", "/proj", options())).rejects.toThrow(
			"The sandbox is on but cannot run: bubblewrap (bwrap) not installed",
		);
		expect(exec.commands).toEqual([]);
	});
});

describe("background-bash", () => {
	it("runs its exec through wrapExec", async () => {
		const source = await import("node:fs").then((fs) =>
			fs.readFileSync(new URL("../ext/background-bash/index.ts", import.meta.url), "utf8"),
		);
		expect(source).toMatch(
			/exec: wrapExec\(\s*\(command, cwd, options\) => createLocalBashOperations\(\{ shellPath \}\)\.exec\(command, cwd, options\),\s*\(\) => shellPath,\s*\)/,
		);
	});
});
