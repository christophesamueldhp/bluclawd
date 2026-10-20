/**
 * The sandbox extension: settings to a running sandbox, the network dialog, and powershell.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../ext/sandbox/config.ts";
import sandbox, { networkAsker } from "../ext/sandbox/index.ts";
import {
	forgetWrappedExec,
	type SandboxEngine,
	sandboxStatus,
	setSandboxEngine,
	stopSandbox,
	wrapExec,
} from "../ext/sandbox/runtime.ts";

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
	let engine: SandboxEngine & { configs: RuntimeConfig[]; resets: number };
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
		const configs: RuntimeConfig[] = [];
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
		sandbox({
			on: (event: string, handler: any) => {
				handlers[event] = handler;
			},
		} as any);
		const ctx = {
			cwd: dir,
			hasUI: true,
			isProjectTrusted: () => true,
			ui: { notify: (text: string) => notes.push(text), confirm: async () => false },
		};
		const start = () => handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
		const call = (toolName: string) => handlers.tool_call({ toolName, input: { command: "Get-Content x" } }, ctx);
		return { handlers, ctx, notes, start, call };
	}

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
