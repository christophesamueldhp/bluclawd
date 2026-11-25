import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { createEventBus, type EventBus, getAgentDir, type SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import permissions from "../ext/permissions/index.ts";
import sandbox, { networkAsker } from "../ext/sandbox/index.ts";
import {
	resetBashWrapOnLoad,
	type SandboxEngine,
	sandboxStatus,
	setSandboxEngine,
	stopSandbox,
	wrapExec,
} from "../ext/sandbox/runtime.ts";

const reaper = vi.hoisted(() => ({ problem: undefined as string | undefined }));
vi.mock("../ext/sandbox/reaper.ts", () => ({
	reapDescendantsOfSimpleCommand: (exec: unknown) => exec,
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
			canBlockUnixSockets: async () => true,
			initialize: async (config) => {
				configs.push(config);
			},
			updateConfig: (config) => {
				configs.push(config);
			},
			getLinuxGlobPatternWarnings: () => [],
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
		resetBashWrapOnLoad();
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
		const events = createEventBus();
		sandbox({
			registerCommand: (name: string, command: any) => {
				commands[name] = command;
			},
			on: (event: string, handler: any) => {
				handlers[event] = handler;
			},
			events,
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
		const start = (reason: SessionStartEvent["reason"] = "startup") =>
			handlers.session_start({ type: "session_start", reason }, ctx);
		const call = (toolName: string) => handlers.tool_call({ toolName, input: { command: "Get-Content x" } }, ctx);
		const command = (args = "") => commands.sandbox.handler(args, ctx);
		return { handlers, ctx, notes, start, call, command, commands, events };
	}

	function loadPermissions(ctx: ReturnType<typeof load>["ctx"], events: EventBus) {
		const handlers: Record<string, (event: any, ctx: any) => Promise<any>> = {};
		permissions({
			on: (event: string, handler: any) => {
				handlers[event] = handler;
			},
			registerShortcut: () => {},
			events,
		} as any);
		const permissionsCtx = {
			...ctx,
			ui: { ...ctx.ui, setStatus: () => {}, theme: { fg: (_c: string, t: string) => t } },
		};
		return {
			start: (event: SessionStartEvent) => handlers.session_start(event, permissionsCtx),
			call: (toolName: string, path: string) => handlers.tool_call({ toolName, input: { path } }, permissionsCtx),
		};
	}

	it("reports unsupported filesystem globs in /sandbox and refuses bash and monitor", async () => {
		engine.getLinuxGlobPatternWarnings = () => [join(dir, "**/.env*")];
		const { start, command, notes, call } = load({
			sandbox: { enabled: true },
			permissions: { deny: ["Write(**/.env*)"] },
		});
		await start();
		notes.length = 0;
		await command("status");
		const reason = expect.stringMatching(/Sandbox cannot run.*\*\*\/\.env\*.*literal path/);
		expect(notes).toEqual([reason]);
		for (const tool of ["bash", "monitor"]) {
			expect(await call(tool)).toEqual({ block: true, reason });
		}
	});

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

	it("adds and removes built-in file tool rules when /sandbox changes", async () => {
		const { handlers, ctx, events, command } = load({ permissions: { deny: ["Write(notes.txt)"] } });
		const permission = loadPermissions(ctx, events);
		const event: SessionStartEvent = { type: "session_start", reason: "startup" };
		await permission.start(event);
		await handlers.session_start(event, ctx);
		const credential = join(getAgentDir(), "auth.json");

		expect(await permission.call("write", ".pi/settings.json")).toBeUndefined();
		expect(await permission.call("read", credential)).toBeUndefined();
		await command("on");
		expect(await permission.call("write", ".pi/settings.json")).toMatchObject({ block: true });
		expect(await permission.call("read", credential)).toMatchObject({ block: true });
		await command("off");
		expect(await permission.call("write", ".pi/settings.json")).toBeUndefined();
		expect(await permission.call("read", credential)).toBeUndefined();
		expect(await permission.call("write", "notes.txt")).toMatchObject({ block: true });
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

	it("refuses bash and monitor when pi cannot parse the global settings", async () => {
		const { start, call } = load({});
		const path = join(getAgentDir(), "settings.json");
		writeFileSync(path, "{ not json");
		const exec = vi.fn(async () => ({ exitCode: 0 }));
		const wrapped = wrapExec(exec, () => undefined);
		await start();
		const bash = await call("bash");
		if (!bash?.block) await wrapped("printf ticket-9", dir, { onData: () => {} });
		expect(exec).not.toHaveBeenCalled();
		for (const result of [bash, await call("monitor")]) {
			expect(result).toMatchObject({ block: true, reason: expect.stringContaining(path) });
		}
		expect(await call("read")).toBeUndefined();
		expect(await call("powershell")).toBeUndefined();
	});

	it.each([
		["global", { invalid: true }],
		["project", { invalid: true }],
		["global", "Write(notes.txt)"],
		["project", ["Write(notes.txt)", false]],
	])("refuses bash and monitor with the sandbox on and a bad %s deny list (%j)", async (scope, deny) => {
		const { start, call } = load({ sandbox: { enabled: true } });
		const settings = { sandbox: { enabled: true }, permissions: { deny } };
		mkdirSync(join(dir, ".pi"));
		const path = join(scope === "global" ? getAgentDir() : join(dir, ".pi"), "settings.json");
		writeFileSync(path, JSON.stringify(settings));
		wrapExec(
			async () => ({ exitCode: 0 }),
			() => undefined,
		);
		await start();
		for (const tool of ["bash", "monitor"]) {
			const result = await call(tool);
			expect(result).toMatchObject({ block: true, reason: expect.stringContaining(path) });
			expect(result.reason).toContain("permissions.deny is not a list of rules");
		}
		expect(await call("read")).toBeUndefined();
	});

	it("refuses bash and monitor with the sandbox on when trusted project settings cannot be parsed", async () => {
		const { start, call } = load({ sandbox: { enabled: true } });
		mkdirSync(join(dir, ".pi"));
		const path = join(dir, ".pi", "settings.json");
		writeFileSync(path, "{ not json");
		wrapExec(
			async () => ({ exitCode: 0 }),
			() => undefined,
		);
		await start();
		for (const tool of ["bash", "monitor"]) {
			const result = await call(tool);
			expect(result).toMatchObject({ block: true, reason: expect.stringContaining(path) });
			expect(result.reason).toContain("could not be read or parsed");
		}
	});

	it("allows bash and monitor with the sandbox on and broken untrusted project settings", async () => {
		const { start, call, ctx, notes } = load({ sandbox: { enabled: true } });
		ctx.isProjectTrusted = () => false;
		mkdirSync(join(dir, ".pi"));
		writeFileSync(join(dir, ".pi", "settings.json"), "{ not json");
		wrapExec(
			async () => ({ exitCode: 0 }),
			() => undefined,
		);
		await start();
		expect(notes).toEqual([]);
		expect(await call("bash")).toBeUndefined();
		expect(await call("monitor")).toBeUndefined();
	});

	it.each([{ deny: { invalid: true } }, { deny: "Write(notes.txt)" }, { deny: ["Write(notes.txt)", false] }])(
		"warns about a bad deny list ($deny) with the sandbox off",
		async ({ deny }) => {
			const { start, call, ctx, notes, events } = load({ sandbox: { enabled: false }, permissions: { deny } });
			const policy = loadPermissions(ctx, events);
			await start();
			await policy.start({ type: "session_start", reason: "startup" });
			expect(notes).toContain("global permissions.deny is not a list of rules: none of it is in effect");
			expect(await policy.call("write", "notes.txt")).toBeUndefined();
			expect(await call("bash")).toBeUndefined();
			expect(await call("monitor")).toBeUndefined();
		},
	);

	it("reports disabled filesystem protection in /sandbox status while the sandbox is on", async () => {
		const { start, command, notes } = load({ sandbox: { enabled: true, filesystem: { disabled: true } } });
		await start();
		await command("status");
		expect(notes.at(-1)).toContain("Filesystem protection is off");
		expect(engine.configs[0]?.filesystem.disabled).toBe(true);
	});

	it("restores bash and monitor on reload after fixing global settings", async () => {
		const broken = load({});
		writeFileSync(join(getAgentDir(), "settings.json"), "{ not json");
		await broken.start();
		expect(await broken.call("bash")).toMatchObject({ block: true });

		const fixed = load({ sandbox: { enabled: true } });
		wrapExec(
			async () => ({ exitCode: 0 }),
			() => undefined,
		);
		await fixed.start("reload");
		expect(await fixed.call("bash")).toBeUndefined();
		expect(await fixed.call("monitor")).toBeUndefined();
		expect(await fixed.call("powershell")).toMatchObject({ block: true });
	});

	it("still warns when permissions read the same session_start's settings first", async () => {
		const { handlers, ctx, events, notes } = load({});
		const permission = loadPermissions(ctx, events);
		writeFileSync(join(getAgentDir(), "settings.json"), "{ not json");
		const event: SessionStartEvent = { type: "session_start", reason: "startup" };
		await permission.start(event);
		await handlers.session_start(event, ctx);
		const path = join(getAgentDir(), "settings.json");
		expect(notes).toEqual([
			`${path} could not be read: its deny rules are not in effect`,
			`Sandbox cannot run: ${path} could not be read or parsed. The model's bash and monitor are refused.`,
		]);
	});

	it("warns once when the sandbox cannot run, or its settings are wrong", async () => {
		engine.checkDependencies = () => ({ errors: ["socat not installed"], warnings: [] });
		const missing = load({ sandbox: { enabled: true } });
		await missing.start();
		expect(missing.notes).toHaveLength(1);
		expect(missing.notes[0]).toContain("Sandbox cannot run: socat not installed");
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
