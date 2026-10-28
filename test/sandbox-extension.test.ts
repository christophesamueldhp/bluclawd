/**
 * The sandbox extension: settings to a running sandbox, the network dialog, and powershell.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sandbox, { networkAsker } from "../ext/sandbox/index.ts";
import {
	forgetWrappedExec,
	type SandboxEngine,
	sandboxStatus,
	setSandboxEngine,
	stopSandbox,
	wrapExec,
} from "../ext/sandbox/runtime.ts";

// The reaper runs real processes; it has its own tests.
const reaper = vi.hoisted(() => ({ problem: undefined as string | undefined }));
vi.mock("../ext/sandbox/reaper.ts", () => ({
	reapDescendants: (exec: unknown) => exec,
	prepareReaper: async () => reaper.problem,
}));

describe("networkAsker", () => {
	const ui = (answer: boolean) => ({ hasUI: true, ui: { confirm: vi.fn(async () => answer) } });

	it("asks once per host and port, concurrent asks sharing one dialog", async () => {
		const ctx = ui(true);
		const asker = networkAsker(() => ctx as any);
		const [a, b] = await Promise.all([
			asker.ask({ host: "x.com", port: 443 }),
			asker.ask({ host: "x.com", port: 443 }),
		]);
		expect([a, b, await asker.ask({ host: "x.com", port: 443 })]).toEqual([true, true, true]);
		expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
		expect(ctx.ui.confirm).toHaveBeenCalledWith(
			"Network access",
			"Allow the model's commands to reach x.com:443 for this session?",
		);
		await asker.ask({ host: "x.com", port: 80 });
		expect(ctx.ui.confirm).toHaveBeenCalledTimes(2);
	});

	it("denies without a UI, and asks again after forget", async () => {
		const ctx = { hasUI: false, ui: { confirm: vi.fn(async () => true) } };
		const asker = networkAsker(() => ctx as any);
		expect(await asker.ask({ host: "x.com", port: undefined })).toBe(false);
		expect(ctx.ui.confirm).not.toHaveBeenCalled();
		ctx.hasUI = true;
		asker.forget();
		expect(await asker.ask({ host: "x.com", port: undefined })).toBe(true);
	});

	it("opens one dialog at a time", async () => {
		let open = 0;
		let maxOpen = 0;
		const confirm = vi.fn(async () => {
			open++;
			maxOpen = Math.max(maxOpen, open);
			await new Promise((resolve) => setTimeout(resolve, 0));
			open--;
			return true;
		});
		const asker = networkAsker(() => ({ hasUI: true, ui: { confirm } }) as any);
		const answers = await Promise.all([
			asker.ask({ host: "a.com", port: 443 }),
			asker.ask({ host: "b.com", port: 443 }),
		]);
		expect(answers).toEqual([true, true]);
		expect(confirm).toHaveBeenCalledTimes(2);
		expect(maxOpen).toBe(1);
	});

	describe("while subagents run commands", () => {
		const child = (name: string) => ({ name, reportNetworkDenied: vi.fn() });
		const api = child("api");
		const ui1 = child("ui");
		const running = new Map<string, ReturnType<typeof child> | undefined>([
			["api-1", api],
			["ui-1", ui1],
			["api-2", api],
			["main-1", undefined],
		]);
		const deniedToChild = { allow: false, reason: expect.stringMatching(/orchestrator/) };

		beforeEach(() => {
			api.reportNetworkDenied.mockClear();
			ui1.reportNetworkDenied.mockClear();
		});

		it("gives any command the user's earlier answer", async () => {
			const ctx = ui(true);
			const asker = networkAsker(
				() => ctx as any,
				() => running,
			);
			expect(await asker.ask({ host: "x.com", port: 443, commandId: "main-1" })).toBe(true);
			expect(await asker.ask({ host: "x.com", port: 443, commandId: "api-1" })).toBe(true);
			expect(await asker.ask({ host: "x.com", port: 443 })).toBe(true);
			expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
			expect(api.reportNetworkDenied).not.toHaveBeenCalled();
		});

		it("denies a child's command without a dialog, reports it naming that child only, and asks again later", async () => {
			const ctx = ui(true);
			const asker = networkAsker(
				() => ctx as any,
				() => running,
			);
			expect(await asker.ask({ host: "registry.npmjs.org", port: 443, commandId: "ui-1" })).toEqual(deniedToChild);
			expect(ctx.ui.confirm).not.toHaveBeenCalled();
			expect(ui1.reportNetworkDenied).toHaveBeenCalledWith("registry.npmjs.org:443", ["ui"]);
			expect(api.reportNetworkDenied).not.toHaveBeenCalled();

			expect(await asker.ask({ host: "registry.npmjs.org", port: 443, commandId: "main-1" })).toBe(true);
			expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
		});

		it("asks the user for an orchestrator command while children's commands run", async () => {
			const ctx = ui(true);
			const asker = networkAsker(
				() => ctx as any,
				() => running,
			);
			expect(await asker.ask({ host: "x.com", port: 443, commandId: "main-1" })).toBe(true);
			expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
			expect(api.reportNetworkDenied).not.toHaveBeenCalled();
			expect(ui1.reportNetworkDenied).not.toHaveBeenCalled();
		});

		it.each([
			["no id", undefined],
			["an id no running command has", "forged"],
		])("denies a request with %s while any child runs, naming every running child", async (_name, commandId) => {
			const ctx = ui(true);
			const asker = networkAsker(
				() => ctx as any,
				() => running,
			);
			expect(await asker.ask({ host: "x.com", port: 443, commandId })).toEqual(deniedToChild);
			expect(ctx.ui.confirm).not.toHaveBeenCalled();
			expect(api.reportNetworkDenied).toHaveBeenCalledWith("x.com:443", ["api", "ui"]);
		});

		it.each([
			["no id", undefined],
			["an id no running command has", "forged"],
		])("asks for a request with %s while no child runs", async (_name, commandId) => {
			const ctx = ui(true);
			const asker = networkAsker(
				() => ctx as any,
				() => new Map([["main-1", undefined]]),
			);
			expect(await asker.ask({ host: "x.com", port: 443, commandId })).toBe(true);
			expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
		});
	});

	it("denies when reading the session throws", async () => {
		const asker = networkAsker(() => {
			throw new Error("stale ctx");
		});
		expect(await asker.ask({ host: "x.com", port: 443 })).toBe(false);
	});
});

describe("the extension", () => {
	let home: string;
	let dir: string;
	let engine: SandboxEngine & { configs: SandboxRuntimeConfig[]; resets: number };
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "bluclawd-sandbox-home-"));
		dir = mkdtempSync(join(tmpdir(), "bluclawd-sandbox-cwd-"));
		saved.HOME = process.env.HOME;
		for (const key of Object.keys(process.env)) {
			if (key.endsWith("_CODING_AGENT_DIR")) {
				saved[key] = process.env[key];
				delete process.env[key];
			}
		}
		process.env.HOME = home;
		mkdirSync(getAgentDir(), { recursive: true });
		const configs: SandboxRuntimeConfig[] = [];
		engine = {
			configs,
			resets: 0,
			isSupportedPlatform: () => true,
			checkDependencies: () => ({ errors: [], warnings: [] }),
			initialize: async (config) => {
				configs.push(config);
			},
			updateConfig: (config) => {
				configs.push(config);
			},
			wrapWithSandbox: async (command) => command,
			annotateStderrWithSandboxFailures: (_id, stderr) => stderr,
			cleanupAfterCommand: () => {},
			reset: async () => {
				engine.resets++;
			},
		};
		setSandboxEngine(engine);
	});
	afterEach(async () => {
		reaper.problem = undefined;
		await stopSandbox();
		setSandboxEngine(undefined);
		forgetWrappedExec();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(home, { recursive: true, force: true });
		rmSync(dir, { recursive: true, force: true });
	});

	function load(settings: Record<string, unknown>) {
		writeFileSync(join(getAgentDir(), "settings.json"), JSON.stringify(settings));
		const handlers: Record<string, (event: any, ctx: any) => Promise<any>> = {};
		const notes: string[] = [];
		const commands: Record<string, any> = {};
		sandbox({
			registerCommand: (name: string, command: any) => {
				commands[name] = command;
			},
			on: (event: string, handler: any) => {
				handlers[event] = handler;
			},
		} as any);
		const ctx = {
			cwd: dir,
			hasUI: true,
			isProjectTrusted: () => true,
			waitForIdle: vi.fn(async () => {}),
			ui: {
				notify: (text: string) => notes.push(text),
				confirm: async () => false,
				select: vi.fn<(...args: any[]) => Promise<string | undefined>>(async () => undefined),
			},
		};
		const start = () => handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
		const call = (toolName: string) => handlers.tool_call({ toolName, input: { command: "Get-Content x" } }, ctx);
		const command = (args = "") => commands.sandbox.handler(args, ctx);
		return { handlers, ctx, notes, start, call, command, commands };
	}

	it("enables immediately and preserves global settings and sandbox policy", async () => {
		const settings = { theme: "system", sandbox: { enabled: false, network: { allowedDomains: ["github.com"] } } };
		const { start, command, ctx, notes } = load(settings);
		await start();
		await command("on");
		expect(ctx.waitForIdle).toHaveBeenCalledOnce();
		expect(sandboxStatus()).toEqual({ kind: "ready" });
		expect(engine.configs[0].network.allowedDomains).toEqual(["github.com"]);
		expect(JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8"))).toEqual({
			...settings,
			sandbox: { ...settings.sandbox, enabled: true },
		});
		expect(notes.at(-1)).toContain("Saved globally");
	});

	it("disables immediately and retains the policy for the next activation", async () => {
		const settings = { sandbox: { enabled: true, filesystem: { denyRead: ["secret"] } } };
		const { start, command } = load(settings);
		await start();
		await command("off");
		expect(sandboxStatus()).toEqual({ kind: "off" });
		expect(engine.resets).toBe(1);
		expect(JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8"))).toEqual({
			sandbox: { ...settings.sandbox, enabled: false },
		});
	});

	it("shows status without writing or waiting, including without a UI", async () => {
		const { start, command, ctx, notes } = load({});
		await start();
		ctx.hasUI = false;
		await command();
		expect(notes).toEqual(["Sandbox: off."]);
		expect(ctx.waitForIdle).not.toHaveBeenCalled();
		expect(ctx.ui.select).not.toHaveBeenCalled();
		expect(readFileSync(join(getAgentDir(), "settings.json"), "utf8")).toBe("{}");
	});

	it("opens a menu and does nothing on cancellation", async () => {
		const { start, command, ctx } = load({});
		await start();
		await command();
		expect(ctx.ui.select).toHaveBeenCalledOnce();
		expect(ctx.waitForIdle).not.toHaveBeenCalled();
		ctx.ui.select.mockResolvedValue("Turn on");
		await command();
		expect(sandboxStatus()).toEqual({ kind: "ready" });
	});

	it("rejects unknown actions and completes known subcommands", async () => {
		const { command, commands, notes, ctx } = load({});
		await command("oops");
		expect(notes).toEqual(["Usage: /sandbox [on|off|status]"]);
		expect(ctx.waitForIdle).not.toHaveBeenCalled();
		expect(commands.sandbox.getArgumentCompletions("o")).toEqual([
			{ value: "on", label: "on" },
			{ value: "off", label: "off" },
		]);
	});

	it("does not overwrite malformed settings or change the runtime on save failure", async () => {
		const { start, command, notes } = load({ sandbox: { enabled: true } });
		await start();
		const path = join(getAgentDir(), "settings.json");
		writeFileSync(path, "{ broken");
		await command("off");
		expect(sandboxStatus()).toEqual({ kind: "ready" });
		expect(readFileSync(path, "utf8")).toBe("{ broken");
		expect(notes.at(-1)).toContain("Could not save sandbox settings");
	});

	it("keeps commands blocked and reports an activation failure", async () => {
		const { start, command, call, notes } = load({ sandbox: { credential: {} } });
		await start();
		await command("on");
		expect(sandboxStatus().kind).toBe("unavailable");
		expect(notes.at(-1)).toContain("sandbox.credential");
		expect(await call("powershell")).toMatchObject({ block: true });
		await command("status");
		expect(notes.at(-1)).toContain("cannot run");
	});

	it("stays off without sandbox.enabled, and leaves powershell alone", async () => {
		const { start, call, notes } = load({});
		await start();
		expect(sandboxStatus()).toEqual({ kind: "off" });
		expect(await call("powershell")).toBeUndefined();
		expect(notes).toEqual([]);
	});

	it("ignores a project's sandbox settings", async () => {
		const { start } = load({});
		mkdirSync(join(dir, ".pi"));
		writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ sandbox: { enabled: true } }));
		await start();
		expect(sandboxStatus()).toEqual({ kind: "off" });
	});

	it("starts with the deny rules' paths, and blocks powershell", async () => {
		const { start, call } = load({
			sandbox: { enabled: true, network: { allowedDomains: ["github.com"] } },
			permissions: { deny: ["Read(**/.env*)"] },
		});
		wrapExec(
			async () => ({ exitCode: 0 }),
			() => undefined,
		);
		await start();
		expect(sandboxStatus()).toEqual({ kind: "ready" });
		expect(engine.configs[0].filesystem.denyRead).toEqual([join(dir, "**/.env*")]);
		expect(engine.configs[0].filesystem.allowWrite[0]).toBe(dir);
		expect(engine.configs[0].network.allowedDomains).toEqual(["github.com"]);
		expect(await call("powershell")).toEqual({
			block: true,
			reason: "The sandbox is on and powershell does not run inside it; use bash.",
		});
		expect(await call("bash")).toBeUndefined();
	});

	it("blocks bash while no wrapped bash is loaded, and allows it once one is", async () => {
		const { start, call } = load({ sandbox: { enabled: true } });
		await start();
		expect(sandboxStatus()).toEqual({ kind: "ready" });
		expect(await call("bash")).toEqual({
			block: true,
			reason:
				"The sandbox is on but bluclawd's bash, which runs inside it, is not loaded; enable bluclawd's background-bash extension.",
		});
		wrapExec(
			async () => ({ exitCode: 0 }),
			() => undefined,
		);
		expect(await call("bash")).toBeUndefined();
	});

	it("blocks bash after a reload that no longer loads background-bash", async () => {
		wrapExec(
			async () => ({ exitCode: 0 }),
			() => undefined,
		);
		const { start, call } = load({ sandbox: { enabled: true } });
		await start();
		expect(await call("bash")).toMatchObject({ block: true });
	});

	it("leaves bash alone while the sandbox is off", async () => {
		const { start, call } = load({});
		await start();
		expect(await call("bash")).toBeUndefined();
	});

	it("marks the sandbox unavailable when starting it throws", async () => {
		const { start, ctx, notes } = load({ sandbox: { enabled: true } });
		ctx.isProjectTrusted = () => {
			throw new Error("boom");
		};
		await start();
		expect(sandboxStatus()).toEqual({ kind: "unavailable", reason: "boom" });
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("boom");
	});

	it("warns when the global settings cannot be read", async () => {
		const { start, notes } = load({});
		writeFileSync(join(getAgentDir(), "settings.json"), "{ not json");
		await start();
		expect(sandboxStatus()).toEqual({ kind: "off" });
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("could not be read");
	});

	it("warns once when the sandbox cannot run, or its settings are wrong", async () => {
		engine.checkDependencies = () => ({ errors: ["socat not installed"], warnings: [] });
		const missing = load({ sandbox: { enabled: true } });
		await missing.start();
		expect(missing.notes).toHaveLength(1);
		expect(missing.notes[0]).toContain("Sandbox is on but cannot run: socat not installed");
		expect(missing.notes[0]).toContain("The model's bash and monitor are refused.");

		await stopSandbox();
		const wrong = load({ sandbox: { enabled: "yes" } });
		await wrong.start();
		expect(sandboxStatus()).toEqual({ kind: "unavailable", reason: "sandbox.enabled is not true or false" });
		expect(wrong.notes[0]).toContain("sandbox.enabled is not true or false");
	});

	it("warns when the sandbox runs but cannot reap a command's descendants", async () => {
		reaper.problem = "the Command Line Tools are not installed";
		const ready = load({ sandbox: { enabled: true } });
		await ready.start();
		expect(sandboxStatus()).toEqual({ kind: "ready" });
		expect(ready.notes).toHaveLength(1);
		expect(ready.notes[0]).toContain("the Command Line Tools are not installed");
		expect(ready.notes[0]).toContain("descendants");

		await stopSandbox();
		const off = load({});
		await off.start();
		expect(off.notes).toEqual([]);

		engine.checkDependencies = () => ({ errors: ["socat not installed"], warnings: [] });
		const unavailable = load({ sandbox: { enabled: true } });
		await unavailable.start();
		expect(unavailable.notes).toHaveLength(1);
		expect(unavailable.notes[0]).toContain("socat not installed");
	});

	it("cannot run with a key srt does not know, so a misspelled protection never goes missing", async () => {
		const { start, call, notes } = load({ sandbox: { enabled: true, credential: { envVars: [] } } });
		await start();
		expect(sandboxStatus()).toEqual({
			kind: "unavailable",
			reason: "sandbox.credential is not a sandbox setting",
		});
		expect(notes[0]).toContain("sandbox.credential is not a sandbox setting");
		expect(engine.configs).toEqual([]);
		expect(await call("powershell")).toMatchObject({ block: true });
	});

	it("stops when a later session start no longer enables it", async () => {
		const { start } = load({ sandbox: { enabled: true } });
		await start();
		expect(sandboxStatus()).toEqual({ kind: "ready" });
		writeFileSync(join(getAgentDir(), "settings.json"), "{}");
		await start();
		expect(engine.resets).toBe(1);
		expect(sandboxStatus()).toEqual({ kind: "off" });
	});

	it("stops on quit only; another session start updates the config", async () => {
		const { start, handlers, ctx } = load({ sandbox: { enabled: true } });
		await start();
		await handlers.session_shutdown({ type: "session_shutdown", reason: "new" }, ctx);
		expect(engine.resets).toBe(0);
		await start();
		expect(engine.configs).toHaveLength(2);
		await handlers.session_shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
		expect(engine.resets).toBe(1);
		expect(sandboxStatus()).toEqual({ kind: "off" });
	});
});
