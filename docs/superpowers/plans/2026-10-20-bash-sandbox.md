# Bash Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the model's `bash` and `monitor` commands inside Anthropic's sandbox runtime when `sandbox.enabled` is set, so a `Read`-denied file such as `.env` cannot be read by any process the model starts.

**Architecture:** A new extension `ext/sandbox/` turns global `sandbox` settings plus `Read`/`Edit`/`Write` deny rules into an `srt` config (`config.ts`), holds one process-wide sandbox (`runtime.ts`, state in `sharedRef`), and wires session lifecycle, the network-ask dialog and a `powershell` block (`index.ts`). `ext/background-bash/index.ts` wraps its single `exec` with `wrapExec`, so every model shell command goes through the sandbox. Spec: `docs/superpowers/specs/2026-10-20-bash-sandbox-design.md`.

**Tech Stack:** TypeScript (Node 26, ESM, `--experimental-strip-types` style `.ts` imports), pi extension API (`@earendil-works/pi-coding-agent` 1.0.4), `@anthropic-ai/sandbox-runtime` 0.0.81, vitest 4, biome.

**Conventions:** tabs, double quotes, `.ts` import suffixes, brief doc comments only where the reason is not obvious. Persisted text in English. No lockfile is committed in this repo. Run tests with `npx vitest run <file>`. Commits end with:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QAwWyZzY8NzuZRgPnNNCg4
```

Another session may commit on `main` at the same time: stage only the files each task names, never `git add -A`.

---

## File structure

| File | Responsibility |
|---|---|
| Create `ext/sandbox/config.ts` | Parse `sandbox` from global settings; build the `srt` config from settings and deny rules. Pure |
| Create `ext/sandbox/runtime.ts` | Process-wide sandbox state, start/stop, `wrapExec` |
| Create `ext/sandbox/index.ts` | The extension: lifecycle, warning, network asker, `powershell` block |
| Modify `ext/permissions/rules.ts` | Export `pathRule()` so the sandbox reads rules with the same parser |
| Modify `ext/background-bash/index.ts:144-146` | Wrap `exec` with `wrapExec` |
| Modify `ext/index.ts`, `package.json` | Register the extension after `permissions`; add the dependency |
| Create `test/sandbox-config.test.ts`, `test/sandbox-runtime.test.ts`, `test/sandbox-extension.test.ts`, `test/sandbox-integration.test.ts` | Tests |
| Modify `test/registration.test.ts` | New extension's registration |
| Modify `README.md` | Sandbox subsection |
| Modify `docs/superpowers/specs/2026-10-20-bash-sandbox-design.md` | Stop only on `quit` (see Task 4) |

---

### Task 1: Add the dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the pinned package without creating a lockfile**

Run: `npm install --save-exact --no-package-lock @anthropic-ai/sandbox-runtime@0.0.81`

Expected: `package.json` gains

```json
  "dependencies": {
    "@anthropic-ai/sandbox-runtime": "0.0.81"
  },
```

and `ls node_modules/@anthropic-ai/sandbox-runtime/dist/index.js` exists. `git status --short` shows no `package-lock.json`.

- [ ] **Step 2: Check it loads**

Run: `node -e 'import("@anthropic-ai/sandbox-runtime").then(m => console.log(typeof m.SandboxManager.initialize))'`

Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "build(sandbox): depend on Anthropic's sandbox runtime 0.0.81" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QAwWyZzY8NzuZRgPnNNCg4"
```

---

### Task 2: `pathRule()` and `config.ts`

**Files:**
- Modify: `ext/permissions/rules.ts` (after `capitalize`, around line 137)
- Create: `ext/sandbox/config.ts`
- Test: `test/sandbox-config.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/sandbox-config.test.ts`:

```ts
/**
 * The sandbox's settings and the `srt` config they make with the deny rules.
 */
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { pathRule } from "../ext/permissions/rules.ts";
import { parseSandbox, runtimeConfig, sandboxSetting } from "../ext/sandbox/config.ts";

const none = { allowedDomains: [], allowWrite: [], denyRead: [], denyWrite: [] };

describe("pathRule", () => {
	it("reads Read, Edit and Write rules with a path, any case", () => {
		expect(pathRule("Read(**/.env*)")).toEqual({ verb: "Read", path: "**/.env*" });
		expect(pathRule("edit(~/.ssh/**)")).toEqual({ verb: "Edit", path: "~/.ssh/**" });
		expect(pathRule("Write")).toEqual({ verb: "Write", path: "**" });
		expect(pathRule("Bash(rm *)")).toBeUndefined();
		expect(pathRule("mcp__github")).toBeUndefined();
	});
});

describe("parseSandbox", () => {
	it("is off when absent or not enabled", () => {
		expect(parseSandbox(undefined)).toEqual({ kind: "off" });
		expect(parseSandbox({})).toEqual({ kind: "off" });
		expect(parseSandbox({ enabled: false, network: "junk" })).toEqual({ kind: "off" });
	});

	it("is on with its lists, missing ones empty", () => {
		expect(parseSandbox({ enabled: true, network: { allowedDomains: ["github.com"] } })).toEqual({
			kind: "on",
			settings: { ...none, allowedDomains: ["github.com"] },
		});
	});

	it("names what is wrong, so a typo never switches the sandbox off", () => {
		expect(parseSandbox("yes")).toEqual({ kind: "invalid", reason: "sandbox is not an object" });
		expect(parseSandbox({ enabled: "yes" })).toEqual({
			kind: "invalid",
			reason: "sandbox.enabled is not true or false",
		});
		expect(parseSandbox({ enabled: true, filesystem: [] })).toEqual({
			kind: "invalid",
			reason: "sandbox.filesystem is not an object",
		});
		expect(parseSandbox({ enabled: true, filesystem: { denyRead: [".env", 3] } })).toEqual({
			kind: "invalid",
			reason: "sandbox.filesystem.denyRead is not a list of strings",
		});
	});
});

describe("sandboxSetting", () => {
	it("reads global settings only", () => {
		const sm = {
			getGlobalSettings: () => ({}),
			getProjectSettings: () => ({ sandbox: { enabled: true } }),
		} as unknown as SettingsManager;
		expect(sandboxSetting(sm)).toEqual({ kind: "off" });
	});
});

describe("runtimeConfig", () => {
	const cwd = "/proj";
	const home = "/home/u";
	const tmp = "/tmp/x";

	it("denies reading what Read rules deny, anchored at absolute paths", () => {
		const config = runtimeConfig(none, ["Read(**/.env*)", "Read(~/.ssh/**)", "Read(//etc/hosts)", "Read(/abs/k)", "Read(secrets/**)"], cwd, home, tmp);
		expect(config.filesystem.denyRead).toEqual([
			"/proj/**/.env*",
			"/home/u/.ssh/**",
			"/etc/hosts",
			"/abs/k",
			"/proj/secrets/**",
		]);
	});

	it("denies writing what Edit and Write rules deny, and ignores other rules", () => {
		const config = runtimeConfig(none, ["Edit(.git/**)", "Write(**/.env*)", "Bash(rm *)", "WebFetch"], cwd, home, tmp);
		expect(config.filesystem.denyWrite).toEqual(["/proj/.git/**", "/proj/**/.env*"]);
		expect(config.filesystem.denyRead).toEqual([]);
	});

	it("writes to the project and temp, plus allowWrite; adds the settings' own lists once", () => {
		const config = runtimeConfig(
			{ allowedDomains: ["github.com"], allowWrite: ["~/.npm"], denyRead: ["~/**/.env*", "~/**/.env*"], denyWrite: ["/etc"] },
			["Read(~/**/.env*)"],
			cwd,
			home,
			tmp,
		);
		expect(config).toEqual({
			network: { allowedDomains: ["github.com"], deniedDomains: [] },
			filesystem: {
				denyRead: ["/home/u/**/.env*"],
				allowWrite: ["/proj", "/tmp/x", "/home/u/.npm"],
				denyWrite: ["/etc"],
			},
		});
	});
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/sandbox-config.test.ts`

Expected: FAIL, `pathRule` is not exported / `../ext/sandbox/config.ts` cannot be found.

- [ ] **Step 3: Export `pathRule` from `ext/permissions/rules.ts`**

Insert right after `function capitalize(...) { ... }`:

```ts
/** A Read, Edit or Write rule's verb and path, the way the deny rules read it; undefined for any other rule. */
export function pathRule(rule: string): { verb: "Read" | "Edit" | "Write"; path: string } | undefined {
	const parts = ruleParts(rule);
	if (!parts) return undefined;
	const verb = capitalize(parts.verb);
	return verb === "Read" || verb === "Edit" || verb === "Write" ? { verb, path: parts.subject } : undefined;
}
```

- [ ] **Step 4: Create `ext/sandbox/config.ts`**

```ts
/**
 * The `sandbox` settings, and the `srt` config they make together with the deny rules.
 *
 * Only global settings are read: a repository's files must not loosen or switch off the sandbox.
 */
import { isAbsolute, join } from "node:path";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { pathRule } from "../permissions/rules.ts";

export interface SandboxSettings {
	allowedDomains: string[];
	allowWrite: string[];
	denyRead: string[];
	denyWrite: string[];
}

export type SandboxSetting =
	| { kind: "off" }
	| { kind: "on"; settings: SandboxSettings }
	| { kind: "invalid"; reason: string };

/** The fields of `srt`'s `SandboxRuntimeConfig` that bluclawd sets. */
export interface RuntimeConfig {
	network: { allowedDomains: string[]; deniedDomains: string[] };
	filesystem: { denyRead: string[]; allowWrite: string[]; denyWrite: string[] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A list of strings, or the reason it is not one. */
function strings(value: unknown, name: string): string[] | string {
	if (value === undefined) return [];
	return Array.isArray(value) && value.every((v) => typeof v === "string") ? value : `${name} is not a list of strings`;
}

export function sandboxSetting(sm: SettingsManager): SandboxSetting {
	return parseSandbox((sm.getGlobalSettings() as Record<string, unknown>).sandbox);
}

export function parseSandbox(value: unknown): SandboxSetting {
	if (value === undefined) return { kind: "off" };
	if (!isPlainObject(value)) return { kind: "invalid", reason: "sandbox is not an object" };
	if (value.enabled === false) return { kind: "off" };
	if (value.enabled !== undefined && value.enabled !== true) {
		return { kind: "invalid", reason: "sandbox.enabled is not true or false" };
	}
	const network = value.network ?? {};
	const filesystem = value.filesystem ?? {};
	if (!isPlainObject(network)) return { kind: "invalid", reason: "sandbox.network is not an object" };
	if (!isPlainObject(filesystem)) return { kind: "invalid", reason: "sandbox.filesystem is not an object" };
	const lists = {
		allowedDomains: strings(network.allowedDomains, "sandbox.network.allowedDomains"),
		allowWrite: strings(filesystem.allowWrite, "sandbox.filesystem.allowWrite"),
		denyRead: strings(filesystem.denyRead, "sandbox.filesystem.denyRead"),
		denyWrite: strings(filesystem.denyWrite, "sandbox.filesystem.denyWrite"),
	};
	for (const list of Object.values(lists)) if (typeof list === "string") return { kind: "invalid", reason: list };
	return value.enabled === true ? { kind: "on", settings: lists as SandboxSettings } : { kind: "off" };
}

/**
 * A rule or settings path as the sandbox takes it: absolute, since `srt` on Linux skips a
 * pattern whose first component is a wildcard. A relative path is under the working directory.
 */
function sandboxPath(path: string, cwd: string, home: string): string {
	if (path.startsWith("//")) return path.slice(1);
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return isAbsolute(path) ? path : join(cwd, path);
}

export function runtimeConfig(
	settings: SandboxSettings,
	denyRules: string[],
	cwd: string,
	home: string,
	tmp: string,
): RuntimeConfig {
	const ruled = (verbs: string[]) =>
		denyRules.flatMap((rule) => {
			const parsed = pathRule(rule);
			return parsed && verbs.includes(parsed.verb) ? [parsed.path] : [];
		});
	const paths = (list: string[]) => [...new Set(list.map((path) => sandboxPath(path, cwd, home)))];
	return {
		network: { allowedDomains: [...settings.allowedDomains], deniedDomains: [] },
		filesystem: {
			denyRead: paths([...ruled(["Read"]), ...settings.denyRead]),
			allowWrite: paths([cwd, tmp, ...settings.allowWrite]),
			denyWrite: paths([...ruled(["Edit", "Write"]), ...settings.denyWrite]),
		},
	};
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run test/sandbox-config.test.ts test/permissions-deny.test.ts`

Expected: PASS, all tests.

- [ ] **Step 6: Lint and commit**

Run: `npx biome check ext/sandbox ext/permissions test/sandbox-config.test.ts` — expected: no errors (run `npx biome check --write <files>` for formatting-only fixes).

```bash
git add ext/permissions/rules.ts ext/sandbox/config.ts test/sandbox-config.test.ts
git commit -m "feat(sandbox): sandbox settings and the srt config they make with the deny rules" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QAwWyZzY8NzuZRgPnNNCg4"
```

---

### Task 3: `runtime.ts`

**Files:**
- Create: `ext/sandbox/runtime.ts`
- Test: `test/sandbox-runtime.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/sandbox-runtime.test.ts`:

```ts
/**
 * The process-wide sandbox: starting it, and running a command through it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../ext/sandbox/config.ts";
import {
	type Exec,
	markSandboxUnavailable,
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
	const exec = (async (command: string) => {
		commands.push(command);
		return { exitCode: 0 };
	}) as Exec & { commands: string[] };
	exec.commands = commands;
	return exec;
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
		setSandboxEngine(fakeEngine({ checkDependencies: () => ({ errors: ["bubblewrap (bwrap) not installed"], warnings: [] }) }));
		const status = await startSandbox(config, deny, "linux");
		expect(status.kind === "unavailable" && status.reason).toContain("bubblewrap (bwrap) not installed");
		expect(status.kind === "unavailable" && status.reason).toContain("apt install bubblewrap socat");
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
		expect(await startSandbox(config, deny, "darwin")).toEqual({ kind: "unavailable", reason: "proxy failed to start" });
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
		const [first, second] = wrap.mock.calls as unknown as [string, string, undefined, AbortSignal, { commandId: string; commandText: string }][];
		expect(first.slice(0, 4)).toEqual(["ls", "/bin/zsh", undefined, signal]);
		expect(first[4].commandText).toBe("ls");
		expect(first[4].commandId).not.toBe(second[4].commandId);
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/sandbox-runtime.test.ts`

Expected: FAIL, `../ext/sandbox/runtime.ts` cannot be found.

- [ ] **Step 3: Create `ext/sandbox/runtime.ts`**

```ts
/**
 * The sandbox the model's shell commands run in: Anthropic's sandbox runtime (`srt`), one per
 * process. The sandbox extension starts and stops it; background-bash runs every model command
 * through `wrapExec`.
 */
import { randomUUID } from "node:crypto";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { sharedRef } from "../_shared/global-state.ts";
import type { RuntimeConfig } from "./config.ts";

export type Exec = BashOperations["exec"];

/** Whether a sandboxed command may reach a host no rule covers. */
export type AskNetwork = (request: { host: string; port: number | undefined }) => Promise<boolean>;

/** The part of `srt`'s `SandboxManager` bluclawd calls. */
export interface SandboxEngine {
	isSupportedPlatform(): boolean;
	checkDependencies(): { errors: string[]; warnings: string[] };
	initialize(config: RuntimeConfig, ask: AskNetwork, enableLogMonitor: boolean): Promise<void>;
	updateConfig(config: RuntimeConfig): void;
	wrapWithSandbox(
		command: string,
		binShell: string | undefined,
		customConfig: undefined,
		signal: AbortSignal | undefined,
		options: { commandId: string; commandText: string },
	): Promise<string>;
	annotateStderrWithSandboxFailures(commandId: string, stderr: string): string;
	cleanupAfterCommand(): void;
	reset(): Promise<void>;
}

export type SandboxStatus = { kind: "off" } | { kind: "ready" } | { kind: "unavailable"; reason: string };

// Shared, since the sandbox extension and background-bash each load their own copy of this module.
const state = sharedRef<{ status: SandboxStatus; engine?: SandboxEngine }>("sandbox", { status: { kind: "off" } });

const LINUX_HINT =
	"install bubblewrap and socat (apt install bubblewrap socat); on Ubuntu 24.04+ also allow unprivileged user namespaces, see the README";

export function sandboxStatus(): SandboxStatus {
	return state.get().status;
}

function setStatus(status: SandboxStatus): SandboxStatus {
	state.set({ ...state.get(), status });
	return status;
}

/** Swaps the engine, for tests; undefined loads `srt` again on the next start. */
export function setSandboxEngine(engine: SandboxEngine | undefined): void {
	state.set({ ...state.get(), engine });
}

async function engine(): Promise<SandboxEngine> {
	const current = state.get().engine;
	if (current) return current;
	// Loaded when a sandbox first starts, so a session without one never loads it.
	const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
	const loaded = SandboxManager as unknown as SandboxEngine;
	setSandboxEngine(loaded);
	return loaded;
}

export function markSandboxUnavailable(reason: string): SandboxStatus {
	return setStatus({ kind: "unavailable", reason });
}

export async function startSandbox(
	config: RuntimeConfig,
	ask: AskNetwork,
	platform: NodeJS.Platform = process.platform,
): Promise<SandboxStatus> {
	if (platform === "win32") {
		return markSandboxUnavailable("the sandbox needs macOS, Linux or WSL2; on Windows run pi in WSL2");
	}
	try {
		const sandbox = await engine();
		if (state.get().status.kind === "ready") {
			sandbox.updateConfig(config);
			return sandboxStatus();
		}
		if (!sandbox.isSupportedPlatform()) return markSandboxUnavailable(`the sandbox does not support ${platform}`);
		const { errors } = sandbox.checkDependencies();
		if (errors.length > 0) {
			return markSandboxUnavailable(platform === "linux" ? `${errors.join("; ")}: ${LINUX_HINT}` : errors.join("; "));
		}
		await sandbox.initialize(config, ask, true);
		return setStatus({ kind: "ready" });
	} catch (error) {
		return markSandboxUnavailable(error instanceof Error ? error.message : String(error));
	}
}

export async function stopSandbox(): Promise<void> {
	const { status, engine: sandbox } = state.get();
	setStatus({ kind: "off" });
	if (status.kind === "ready" && sandbox) await sandbox.reset();
}

/**
 * `exec` run inside the sandbox while it is ready, refused while it is on but cannot run, and
 * unchanged while it is off. The wrapped command must run asynchronously: `srt`'s proxy lives on
 * this process's event loop.
 */
export function wrapExec(exec: Exec, shellPath: () => string | undefined): Exec {
	return async (command, cwd, options) => {
		const { status, engine: sandbox } = state.get();
		if (status.kind === "off") return exec(command, cwd, options);
		if (status.kind === "unavailable" || !sandbox) {
			const reason = status.kind === "unavailable" ? status.reason : "it has not started";
			throw new Error(`The sandbox is on but cannot run: ${reason}`);
		}
		const commandId = randomUUID();
		const wrapped = await sandbox.wrapWithSandbox(command, shellPath(), undefined, options.signal, {
			commandId,
			commandText: command,
		});
		try {
			return await exec(wrapped, cwd, options);
		} finally {
			const blocked = sandbox.annotateStderrWithSandboxFailures(commandId, "").trim();
			if (blocked) options.onData(Buffer.from(`\n${blocked}\n`));
			sandbox.cleanupAfterCommand();
		}
	};
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run test/sandbox-runtime.test.ts`

Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck, lint and commit**

Run: `npm run typecheck` — expected: exit 0. If `SandboxManager as unknown as SandboxEngine` is the only cast, that is intended: `srt`'s own signatures are wider than the part bluclawd calls.

Run: `npx biome check ext/sandbox test/sandbox-runtime.test.ts` — expected: no errors.

```bash
git add ext/sandbox/runtime.ts test/sandbox-runtime.test.ts
git commit -m "feat(sandbox): one sandbox per process, and exec run through it" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QAwWyZzY8NzuZRgPnNNCg4"
```

---

### Task 4: The extension `ext/sandbox/index.ts`

**Files:**
- Create: `ext/sandbox/index.ts`
- Modify: `ext/index.ts`, `package.json` (`pi.extensions`), `test/registration.test.ts`
- Modify: `docs/superpowers/specs/2026-10-20-bash-sandbox-design.md` (U3 `session_shutdown` line)
- Test: `test/sandbox-extension.test.ts`

Lifecycle note: background shells survive `/new`, `/resume` and `/fork` (the new session owns them), so the sandbox is stopped only on `session_shutdown` with `reason: "quit"`; any other start updates its config.

- [ ] **Step 1: Write the failing tests**

Create `test/sandbox-extension.test.ts`:

```ts
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
import { type SandboxEngine, sandboxStatus, setSandboxEngine, stopSandbox } from "../ext/sandbox/runtime.ts";

describe("networkAsker", () => {
	const ui = (answer: boolean) => ({ hasUI: true, ui: { confirm: vi.fn(async () => answer) } });

	it("asks once per host and port, concurrent asks sharing one dialog", async () => {
		const ctx = ui(true);
		const asker = networkAsker(() => ctx as any);
		const [a, b] = await Promise.all([asker.ask({ host: "x.com", port: 443 }), asker.ask({ host: "x.com", port: 443 })]);
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
```

Note: `checkDependencies` is replaced on the shared `engine` object in the warning test; the second `load` reuses it, which is fine because the second case fails on settings before reaching the engine.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/sandbox-extension.test.ts`

Expected: FAIL, `../ext/sandbox/index.ts` cannot be found.

- [ ] **Step 3: Create `ext/sandbox/index.ts`**

```ts
/**
 * Runs the model's shell commands in Anthropic's sandbox runtime when global settings set
 * `sandbox.enabled`: the OS keeps them from reading what a `Read` rule denies, from writing
 * outside the project and temp, and from reaching a host the user has not allowed.
 *
 * Starts the sandbox each session (runtime.ts holds it; background-bash runs bash and monitor
 * through it), asks before a command reaches an unlisted host, and blocks pi's powershell tool,
 * which does not run through the sandbox. Registered right after permissions, so a deny rule
 * still blocks a call first.
 */
import { homedir, tmpdir } from "node:os";
import type {
	ExtensionAPI,
	ExtensionContext,
	InlineExtension,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { denyRules } from "../_shared/settings.ts";
import { runtimeConfig, sandboxSetting } from "./config.ts";
import { type AskNetwork, markSandboxUnavailable, sandboxStatus, startSandbox, stopSandbox } from "./runtime.ts";

/** Asks the user once per host and port per session; concurrent asks share one dialog; no UI denies. */
export function networkAsker(context: () => ExtensionContext | undefined): { ask: AskNetwork; forget(): void } {
	const answers = new Map<string, Promise<boolean>>();
	return {
		ask: ({ host, port }) => {
			const target = port === undefined ? host : `${host}:${port}`;
			let answer = answers.get(target);
			if (!answer) {
				const ctx = context();
				answer = ctx?.hasUI
					? ctx.ui
							.confirm("Network access", `Allow the model's commands to reach ${target} for this session?`)
							.catch(() => false)
					: Promise.resolve(false);
				answers.set(target, answer);
			}
			return answer;
		},
		forget: () => answers.clear(),
	};
}

function factory(pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	const asker = networkAsker(() => ctx);

	pi.on("session_start", async (_event, startCtx) => {
		ctx = startCtx;
		asker.forget();
		const sm = SettingsManager.create(startCtx.cwd, undefined, { projectTrusted: startCtx.isProjectTrusted() });
		const setting = sandboxSetting(sm);
		if (setting.kind === "off") {
			await stopSandbox();
			return;
		}
		const status =
			setting.kind === "invalid"
				? markSandboxUnavailable(setting.reason)
				: await startSandbox(runtimeConfig(setting.settings, denyRules(sm), startCtx.cwd, homedir(), tmpdir()), asker.ask);
		if (status.kind === "unavailable") {
			startCtx.ui.notify(
				`Sandbox is on but cannot run: ${status.reason}. The model's bash and monitor are refused.`,
				"warning",
			);
		}
	});

	// Background shells outlive /new, /resume and /fork, so only quitting takes the sandbox down.
	pi.on("session_shutdown", async (event) => {
		if (event.reason === "quit") await stopSandbox();
	});

	pi.on("tool_call", async (event): Promise<ToolCallEventResult | undefined> => {
		if (event.toolName !== "powershell" || sandboxStatus().kind === "off") return undefined;
		return { block: true, reason: "The sandbox is on and powershell does not run inside it; use bash." };
	});
}

const sandboxExtension: InlineExtension = { name: "sandbox", factory };
export default sandboxExtension.factory;
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run test/sandbox-extension.test.ts`

Expected: PASS, 7 tests.

- [ ] **Step 5: Register the extension**

`package.json`, `pi.extensions`: insert `"./ext/sandbox/index.ts",` right after `"./ext/permissions/index.ts",`.

`ext/index.ts`: add `import sandbox from "./sandbox/index.ts";` in alphabetical position (after `remote`), and in `bluclawdExtensions()` insert `{ name: "sandbox", factory: sandbox },` right after the `permissions` entry. In the file's doc comment, change

```
 * ordering — keep this list in sync with it. Order matters only for
 * permissions, which must see `tool_call` before anything that might answer
 * it — keep it first.
```

to

```
 * ordering — keep this list in sync with it. Order matters only for
 * permissions, which must see `tool_call` before anything that might answer
 * it — keep it first — and sandbox, which comes right after it.
```

`test/registration.test.ts`: in `EXPECTED`, after the `permissions` line add

```ts
	sandbox: { commands: [], tools: [], shortcuts: 0, events: 3 },
```

and rename the test `"registers exactly the 9 expected extensions, no more, no fewer"` to `"registers exactly the 10 expected extensions, no more, no fewer"`.

- [ ] **Step 6: Update the spec's lifecycle line**

In `docs/superpowers/specs/2026-10-20-bash-sandbox-design.md`, U3, replace

```
- `session_shutdown`: `stop()`.
```

with

```
- `session_shutdown` with `reason: "quit"`: `stop()`. Background shells outlive `/new`,
  `/resume` and `/fork`, so any other shutdown keeps the sandbox, and the next `session_start`
  updates its config.
```

- [ ] **Step 7: Run the affected suites**

Run: `npx vitest run test/sandbox-extension.test.ts test/registration.test.ts`

Expected: PASS.

- [ ] **Step 8: Lint and commit**

Run: `npx biome check ext/sandbox ext/index.ts test/sandbox-extension.test.ts test/registration.test.ts package.json` — expected: no errors.

```bash
git add ext/sandbox/index.ts ext/index.ts package.json test/sandbox-extension.test.ts test/registration.test.ts docs/superpowers/specs/2026-10-20-bash-sandbox-design.md
git commit -m "feat(sandbox): start the sandbox from global settings, ask before an unlisted host, block powershell" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QAwWyZzY8NzuZRgPnNNCg4"
```

---

### Task 5: Run background-bash through the sandbox

**Files:**
- Modify: `ext/background-bash/index.ts:21` (imports) and `:144-146`
- Test: `test/sandbox-integration.test.ts` (Task 6 covers the real run); here a wiring test

- [ ] **Step 1: Write the failing wiring test**

Append to `test/sandbox-runtime.test.ts`, inside a new `describe`:

```ts
describe("background-bash", () => {
	it("runs its exec through wrapExec", async () => {
		const source = await import("node:fs").then((fs) =>
			fs.readFileSync(new URL("../ext/background-bash/index.ts", import.meta.url), "utf8"),
		);
		expect(source).toMatch(/exec: wrapExec\(\s*\(command, cwd, options\) => createLocalBashOperations\(\{ shellPath \}\)\.exec\(command, cwd, options\),\s*\(\) => shellPath,\s*\)/);
	});
});
```

This pins the one line every model shell command goes through; the real behavior is covered by Task 6.

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/sandbox-runtime.test.ts -t "background-bash"`

Expected: FAIL, the regex does not match.

- [ ] **Step 3: Wrap the exec**

In `ext/background-bash/index.ts` add the import next to the other `../` imports:

```ts
import { wrapExec } from "../sandbox/runtime.ts";
```

and replace

```ts
		const operations: BashOperations = {
			exec: (command, cwd, options) => createLocalBashOperations({ shellPath }).exec(command, cwd, options),
		};
```

with

```ts
		// Inside the sandbox when it is on (ext/sandbox): every model shell command runs through here.
		const operations: BashOperations = {
			exec: wrapExec(
				(command, cwd, options) => createLocalBashOperations({ shellPath }).exec(command, cwd, options),
				() => shellPath,
			),
		};
```

- [ ] **Step 4: Run background-bash's suites and the wiring test**

Run: `npx vitest run test/sandbox-runtime.test.ts $(ls test/*background* test/*bash* test/*monitor* 2>/dev/null | tr '\n' ' ')`

Expected: PASS.

- [ ] **Step 5: Lint and commit**

Run: `npx biome check ext/background-bash/index.ts test/sandbox-runtime.test.ts` — expected: no errors.

```bash
git add ext/background-bash/index.ts test/sandbox-runtime.test.ts
git commit -m "feat(sandbox): the model's bash and monitor run through the sandbox" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QAwWyZzY8NzuZRgPnNNCg4"
```

---

### Task 6: Integration test with the real `srt`

**Files:**
- Create: `test/sandbox-integration.test.ts`

- [ ] **Step 1: Write the test**

```ts
/**
 * The real sandbox runtime around a real shell: a Read-denied .env stays unreadable to any
 * command, writes stay in the project, and an unlisted host is refused. Skipped where `srt`
 * cannot run (native Windows, Linux without bubblewrap/socat).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runtimeConfig } from "../ext/sandbox/config.ts";
import { setSandboxEngine, startSandbox, stopSandbox, wrapExec } from "../ext/sandbox/runtime.ts";

function has(binary: string): boolean {
	try {
		execFileSync("which", [binary], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const supported = process.platform === "darwin" || (process.platform === "linux" && has("bwrap") && has("socat"));

describe.skipIf(!supported)("the sandbox, for real", () => {
	let dir: string;
	const probe = join(homedir(), `.bluclawd-sandbox-probe-${process.pid}`);
	const exec = wrapExec((command, cwd, options) => createLocalBashOperations().exec(command, cwd, options), () => undefined);

	async function run(command: string): Promise<{ code: number | null; output: string }> {
		let output = "";
		const { exitCode } = await exec(command, dir, { onData: (data) => (output += data.toString()) });
		return { code: exitCode, output };
	}

	beforeAll(async () => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "bluclawd-sandbox-it-")));
		writeFileSync(join(dir, ".env"), "SECRET=hunter2\n");
		writeFileSync(join(dir, "app.ts"), "const SECRET = process.env.SECRET;\n");
		setSandboxEngine(undefined);
		const config = runtimeConfig(
			{ allowedDomains: [], allowWrite: [], denyRead: [], denyWrite: [] },
			["Read(**/.env*)"],
			dir,
			homedir(),
			tmpdir(),
		);
		expect(await startSandbox(config, async () => false)).toEqual({ kind: "ready" });
	}, 60_000);

	afterAll(async () => {
		await stopSandbox();
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
		expect((await run(`echo x > ${probe}`)).code).not.toBe(0);
		expect(existsSync(probe)).toBe(false);
	});

	it("refuses a host the user did not allow", async () => {
		const { output } = await run("curl -sS -m 10 https://example.com -o /dev/null -w '%{http_code}'");
		expect(output).toMatch(/403|000/);
	});
}, 120_000);
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/sandbox-integration.test.ts`

Expected on macOS: PASS, 4 tests. If `grep -r` output contains `Operation not permitted` lines for `.env`, that is the sandbox working. If the network case prints a code other than `403`/`000`, inspect `output` before changing the assertion: it must never be `200`.

- [ ] **Step 3: Commit**

```bash
git add test/sandbox-integration.test.ts
git commit -m "test(sandbox): a Read-denied .env stays unreadable to any command under the real srt" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QAwWyZzY8NzuZRgPnNNCg4"
```

---

### Task 7: README

**Files:**
- Modify: `README.md` (end of the Permissions section, after the paragraph that ends "is not caught.")

- [ ] **Step 1: Add the subsection**

Insert after that paragraph:

````markdown
### Sandbox

Deny rules match the text of a call, so `grep -r KEY .` or a script that opens `.env`
still reads it. Turn on the sandbox to have the operating system stop that: the model's
`bash` and `monitor` commands, and everything they start, then run inside Anthropic's
[sandbox runtime](https://github.com/anthropics/sandbox-runtime), the one Claude Code uses.
Set it in `~/.pi/agent/settings.json` (a project's settings cannot change it):

```json
{
  "sandbox": {
    "enabled": true,
    "network": { "allowedDomains": ["registry.npmjs.org", "github.com"] },
    "filesystem": { "allowWrite": ["~/.npm"], "denyRead": [], "denyWrite": [] }
  },
  "permissions": { "deny": ["Read(**/.env*)"] }
}
```

- Reads: everything except what a `Read` rule denies, plus `filesystem.denyRead`.
- Writes: the working directory and the temp directory, plus `filesystem.allowWrite`; never
  what an `Edit` or `Write` rule denies. Under the sandbox a `Write` rule blocks `>>` too.
- Network: hosts in `network.allowedDomains`; for any other, pi asks once per session
  (without a UI, it is refused).
- Rule paths are anchored at the working directory: `Read(**/.env*)` covers `.env` files
  under the project. Add others to `filesystem.denyRead`, e.g. `~/**/.env*`.
- When the sandbox cannot run, the model's `bash` and `monitor` are refused and pi says
  why. There is no unsandboxed fallback. pi's `powershell` tool is blocked while it is on.
- Outside the sandbox: commands you type with `!`, pi's own tools (`read`, `grep`, `edit`,
  …, which the deny rules govern), MCP servers and other extensions. An app the model
  starts cannot read `.env` either; run it yourself with `!`.

| Platform | Needs |
|---|---|
| macOS | Nothing (Seatbelt) |
| Linux, WSL2 | `bubblewrap` and `socat` (`apt install bubblewrap socat`). On Ubuntu 24.04+, unprivileged user namespaces must be allowed by AppArmor: see [Anthropic's notes](https://code.claude.com/docs/en/sandboxing#set-up-linux-and-wsl2) |
| Windows | Not supported; run pi in WSL2 |
````

- [ ] **Step 2: Check the link targets and formatting**

Run: `npx biome check README.md 2>&1 | tail -2` — expected: no errors (biome may ignore Markdown; then read the rendered section with `sed -n '/^### Sandbox/,/^## /p' README.md`).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(sandbox): how to turn on the sandbox and what it covers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QAwWyZzY8NzuZRgPnNNCg4"
```

---

### Task 8: Full verification and a real pi session

- [ ] **Step 1: Whole suite, typecheck, lint**

Run: `npm test 2>&1 | tail -4; npm run typecheck; echo typecheck=$?; npx biome check ext test 2>&1 | tail -2`

Expected: all test files pass (previous total 934 plus the new ones), `typecheck=0`, biome no errors.

- [ ] **Step 2: Check the sandbox in pi itself**

1. Put the settings from Task 7 into `~/.pi/agent/settings.json` (keep the user's existing keys).
2. In a scratch folder holding `.env` (`SECRET=hunter2`) and `app.ts`, start pi from this repo (`node bin.mjs` or the user's installed pi pointed at this checkout).
3. Ask the model: "run `grep -r SECRET .` and `cat .env`".
4. Expected: the grep output shows `app.ts` and an `Operation not permitted` (or `<sandbox_violations>`) line for `.env`, never `hunter2`; `cat .env` fails the same way.
5. Ask it to run `curl -sS https://example.com -o /dev/null`: a "Network access" dialog appears; answer No; the command fails.
6. Set `"enabled": false`, `/reload`: the same `grep -r` now prints `hunter2` (sandbox off, as before).

Report the observed output of each step; do not claim a step that was not run.
