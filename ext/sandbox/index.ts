/**
 * Sandbox core extension (audit C.1, CC parity §4.2): OS-level sandboxing for
 * bash commands via @anthropic-ai/sandbox-runtime (Seatbelt/sandbox-exec on
 * macOS, bubblewrap on Linux).
 *
 * Opt-in: settings.json `sandbox.enabled` (global+project merge, project only
 * when trusted) or --sandbox; --no-sandbox wins over both. Replaces the
 * built-in bash tool with a variant whose operations wrap each command via
 * SandboxManager.wrapWithSandbox before delegating to pi's standard local
 * shell backend — foreground, background (run_in_background), and monitor
 * commands all flow through the same operations seam, so all are sandboxed.
 * Commands the user types (`!` and bash mode) run outside the sandbox, as in
 * Claude Code: the sandbox confines what the model runs, not the user.
 *
 * Claude Code's escape hatches, both settings-driven: `excludedCommands` (rule
 * patterns that always run outside) and the bash tool's
 * `dangerouslyDisableSandbox` retry (honoured unless
 * `allowUnsandboxedCommands: false`; the permission layer decides whether the
 * user is asked). Network: no host is pre-allowed — the first connection to a
 * host asks the user; a yes holds for the session, "don't ask again" saves a
 * `WebFetch(domain:...)` rule.
 *
 * Failure posture: if enabled but initialization fails (missing bubblewrap,
 * unsupported platform, ...), bash falls back to UNSANDBOXED execution with a
 * loud status chip and an error notice — unless `sandbox.failIfUnavailable` is
 * set, in which case bluclawd exits at startup, and should the sandbox fail
 * later (`/sandbox on`) the model's bash refuses to run: the tool, background
 * jobs and the monitor each check strictRefusalReason. The runtime dependency
 * is imported lazily so disabled sessions pay no startup cost.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	CONFIG_DIR_NAME,
	createLocalBashOperations,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { backgroundBashJobs } from "../_shared/background-bash.ts";
import { sharedRef } from "../_shared/global-state.ts";
import { clearMainSession, mainSession, setMainSession } from "../_shared/main-session.ts";
import { deliverOrHold } from "../_shared/notification-hold.ts";
import { SHELL_END_ENTRY, SHELL_START_ENTRY } from "../_shared/orphan-shells.ts";
import * as forkSettings from "../_shared/settings.ts";
import { addProjectRule, setProjectSandboxKeys } from "../_shared/settings-write.ts";
import { STATUS_KEYS } from "../_shared/status-keys.ts";
import { createClaudeBashTool } from "./bash-tool.ts";
import {
	isExcludedCommand,
	resolveSandboxConfig,
	runtimeConfig,
	type SandboxConfig,
	strictRefusalReason,
	withSessionChoices,
} from "./config.ts";
import {
	buildSandboxFailureNote,
	formatSandboxViolations,
	looksLikeSandboxDenial,
	relevantViolations,
} from "./failure-note.ts";
import { createMonitorTool } from "./monitor-tool.ts";
import { isSandboxActive, publishChildBash, publishSandboxPosture, setSandboxActive } from "./state.ts";

/** How much of a command's output is kept to look for a denial message. */
const DENIAL_SCAN_BYTES = 4096;
/** How long a failed command waits for the violation monitor to catch up. */
const VIOLATION_WAIT_MS = 400;
const VIOLATION_POLL_MS = 50;
/** Where the runtime allows sandboxed temp writes by default. */
const SESSION_TMP_ROOT = "/tmp/claude";

type SandboxRuntime = typeof import("@anthropic-ai/sandbox-runtime");

/**
 * The sandbox runtime left running across a session switch for background shells,
 * and the temp dir that goes with it. pi builds a new instance of this extension
 * per session, so this cannot live in the instance.
 */
const keptSandbox = sharedRef<{ kept: boolean; sessionTmp?: string }>("sandbox.kept", { kept: false });
/** The current session's network prompt: the runtime binds one callback, for good, at initialize. */
const hostAsker = sharedRef<((host: string, port: number) => Promise<boolean>) | undefined>(
	"sandbox.hostAsker",
	undefined,
);

/**
 * The repository's shared `.git` when `cwd` is a linked worktree (its git dir and
 * common dir differ), else undefined. Commits there write to the common dir.
 */
function linkedWorktreeCommonDir(cwd: string): string | undefined {
	try {
		const [gitDir, commonDir] = execFileSync("git", ["rev-parse", "--git-dir", "--git-common-dir"], {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		})
			.trim()
			.split("\n")
			.map((dir) => resolve(cwd, dir));
		return commonDir && gitDir !== commonDir ? commonDir : undefined;
	} catch {
		return undefined;
	}
}

export function factory(pi: ExtensionAPI): void {
	pi.registerFlag("sandbox", {
		description: "Enable OS-level sandboxing for bash commands",
		type: "boolean",
	});
	pi.registerFlag("no-sandbox", {
		description: "Disable OS-level sandboxing for bash commands",
		type: "boolean",
	});

	const localCwd = process.cwd();

	let config: SandboxConfig = resolveSandboxConfig(undefined);
	let runtime: SandboxRuntime | undefined;
	let lastError: string | undefined;
	let shellPath: string | undefined;
	let commandPrefix: string | undefined;
	let sessionTmp: string | undefined;
	// The ask callback is bound once at initialize; the context it prompts through
	// is whichever session is live now.
	let liveCtx: ExtensionContext | undefined;
	// Hosts the user allowed this session (`host:port`), and prompts in flight so
	// N parallel connections to one host raise one dialog, not N.
	const sessionAllowedHosts = new Set<string>();
	const pendingHostPrompts = new Map<string, Promise<boolean>>();

	/**
	 * Claude Code's network prompt. "Yes" holds for the session; "don't ask again"
	 * saves a `WebFetch(domain:...)` allow rule, which pre-allows the host for the
	 * sandbox (and for webfetch) from then on. That row is offered only in a trusted
	 * project, the one place a rule can be saved.
	 */
	async function askHost(host: string, port: number): Promise<boolean> {
		const key = `${host}:${port}`;
		if (sessionAllowedHosts.has(key)) return true;
		const pending = pendingHostPrompts.get(key);
		if (pending) return pending;
		const ctx = liveCtx;
		if (!ctx?.hasUI) return false;
		// IPv6 literals are bracketed in domain lists and rules.
		const domain = host.includes(":") ? `[${host}]` : host;
		const persist = ctx.isProjectTrusted() ? `Yes, and don't ask again for ${domain}` : undefined;
		const prompt = ctx.ui
			.select(`Network request outside of sandbox\n\nHost: ${key}\n\nDo you want to allow this connection?`, [
				"Yes",
				...(persist ? [persist] : []),
				"No",
			])
			.then(async (choice) => {
				if (choice !== "Yes" && choice !== persist) return false;
				sessionAllowedHosts.add(key);
				if (choice === persist) {
					config.network.allowedDomains = [...new Set([...config.network.allowedDomains, domain])];
					runtime?.SandboxManager.updateConfig(runtimeConfig(config));
					await addProjectRule(ctx.cwd, "allow", `WebFetch(domain:${domain})`, true);
				}
				return true;
			})
			.catch(() => false)
			.finally(() => pendingHostPrompts.delete(key));
		pendingHostPrompts.set(key, prompt);
		return prompt;
	}

	/** The config for this session's settings and permission rules, as they are on disk now. */
	function loadConfig(ctx: ExtensionContext): SandboxConfig {
		const sm = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
		shellPath = sm.getShellPath();
		commandPrefix = sm.getShellCommandPrefix();
		return resolveSandboxConfig(
			forkSettings.sandbox(sm, { project: ctx.cwd, agent: getAgentDir() }),
			{ sandbox: pi.getFlag("sandbox") === true, noSandbox: pi.getFlag("no-sandbox") === true },
			{
				cwd: ctx.cwd,
				agentDir: getAgentDir(),
				rules: forkSettings.permissions(sm) ?? {},
				gitCommonDir: linkedWorktreeCommonDir(ctx.cwd),
			},
		);
	}

	/**
	 * Settings edits reach the running session, as in Claude Code: before each
	 * sandboxed command the config is re-read, and the runtime updated when the part
	 * it enforces changed; what the session decided is kept (withSessionChoices).
	 */
	function syncConfig(): void {
		const ctx = liveCtx;
		if (!ctx || !runtime) return;
		let next: SandboxConfig;
		try {
			next = loadConfig(ctx);
		} catch {
			return; // A settings file mid-write keeps the config in force.
		}
		const before = JSON.stringify(runtimeConfig(config));
		config = withSessionChoices(next, config);
		if (JSON.stringify(runtimeConfig(config)) !== before) runtime.SandboxManager.updateConfig(runtimeConfig(config));
		publishPosture();
	}

	/**
	 * The denial lines recorded for a command. The macOS log stream delivers with
	 * a little latency (the first command after start can miss it entirely), so a
	 * failed command waits briefly for its lines; a successful one never pays this.
	 */
	async function violationLines(commandId: string): Promise<string[]> {
		const store = runtime?.SandboxManager.getSandboxViolationStore();
		if (!store) return [];
		for (let waited = 0; ; waited += VIOLATION_POLL_MS) {
			const lines = store.getViolationsForCommand(commandId).map((v) => v.line);
			if (relevantViolations(lines).length > 0 || waited >= VIOLATION_WAIT_MS) return lines;
			await new Promise((resolve) => setTimeout(resolve, VIOLATION_POLL_MS));
		}
	}

	function sandboxedOperations(): BashOperations {
		const local = createLocalBashOperations({ shellPath });
		return {
			exec: async (command, cwd, options) => {
				if (!runtime) throw new Error("Sandbox runtime not initialized");
				syncConfig();
				// Violations are attributed by this id (the runtime keys on the first 100
				// chars of the command otherwise, so reruns would inherit old events).
				const commandId = randomUUID();
				const wrapped = await runtime.SandboxManager.wrapWithSandbox(command, undefined, undefined, undefined, {
					commandId,
					commandText: command,
				});
				let tail = "";
				const result = await local.exec(wrapped, cwd, {
					...options,
					onData: (data) => {
						tail = (tail + data.toString()).slice(-DENIAL_SCAN_BYTES);
						options.onData(data);
					},
				});
				if (result.exitCode === 0) return result;
				// Name what the sandbox denied, as Claude Code does, so the model can
				// adapt (or ask to retry unsandboxed) instead of retrying the same thing.
				// The signature scan is the fallback for a denial the monitor missed.
				const violations = relevantViolations(await violationLines(commandId));
				if (violations.length > 0) {
					options.onData(Buffer.from(formatSandboxViolations(violations)));
				}
				if (violations.length > 0 || looksLikeSandboxDenial(tail)) {
					const note = buildSandboxFailureNote(config);
					if (note) options.onData(Buffer.from(note));
				}
				return result;
			},
		};
	}

	const plainOperations = () => createLocalBashOperations({ shellPath });

	/**
	 * The operations a command runs through: the sandbox when it is active and
	 * nothing takes the command out of it — an `excludedCommands` match, or the
	 * model's `dangerouslyDisableSandbox` retry while `allowUnsandboxedCommands`
	 * permits it. The permission layer has already decided whether the user was
	 * asked about the retry.
	 */
	function operationsFor(command: string, disableSandbox = false): BashOperations {
		if (!isSandboxActive()) return plainOperations();
		if (isExcludedCommand(command, config.excludedCommands)) return plainOperations();
		if (disableSandbox && config.allowUnsandboxedCommands) return plainOperations();
		return sandboxedOperations();
	}

	// Override the built-in bash tool. When the sandbox is inactive this runs the
	// same Claude Code bash through unsandboxed operations. Subagent children build
	// theirs from the same factory (bash-tool.ts), so the two cannot drift apart.
	pi.registerTool(
		createClaudeBashTool({
			cwd: localCwd,
			shellPath,
			commandPrefix,
			operations: operationsFor,
			refusal: () => strictRefusalReason(config, isSandboxActive(), lastError),
			sendMessage: (message, delivery) => deliverOrHold(() => mainSession.sendMessage(message, delivery)),
			isMain: true,
			sandboxEscape: true,
			record: {
				start: (record) => mainSession.appendEntry(SHELL_START_ENTRY, record),
				end: (taskId) => mainSession.appendEntry(SHELL_END_ENTRY, { taskId }),
			},
		}),
	);

	// The monitor is the third shell path the model drives (tool, background job,
	// monitor): same refusal, same operations, so the sandbox covers it too.
	pi.registerTool(
		createMonitorTool({
			sendMessage: (message, options) => deliverOrHold(() => mainSession.sendMessage(message, options)),
			cwd: localCwd,
			exec: (command) => operationsFor(command).exec,
			refuse: () => strictRefusalReason(config, isSandboxActive(), lastError),
		}),
	);

	function publishPosture(): void {
		publishSandboxPosture({
			active: isSandboxActive(),
			autoAllowBashIfSandboxed: config.autoAllowBashIfSandboxed,
			allowUnsandboxedCommands: config.allowUnsandboxedCommands,
			isExcluded: (command) => isExcludedCommand(command, config.excludedCommands),
		});
	}

	async function activate(ctx: ExtensionContext): Promise<void> {
		if (process.platform !== "darwin" && process.platform !== "linux") {
			setSandboxActive(false);
			lastError = `not supported on ${process.platform}`;
			ctx.ui.notify(`Sandbox not supported on ${process.platform}`, "warning");
			return;
		}
		try {
			runtime ??= await import("@anthropic-ai/sandbox-runtime");
			// Claude Code's session temp dir. The runtime points sandboxed commands'
			// $TMPDIR at CLAUDE_CODE_TMPDIR (else /tmp/claude) and lets them write under
			// /tmp/claude, but creates neither, so every temp write failed.
			if (!process.env.CLAUDE_CODE_TMPDIR) {
				mkdirSync(SESSION_TMP_ROOT, { recursive: true });
				sessionTmp = mkdtempSync(join(SESSION_TMP_ROOT, "pi-"));
				process.env.CLAUDE_CODE_TMPDIR = sessionTmp;
			}
			// The log monitor is what attributes file denials to commands (network
			// denials come from the proxy regardless).
			// Through the process-wide asker: a runtime kept across a session switch must
			// prompt through the session that is current, not the one that initialized it.
			await runtime.SandboxManager.initialize(
				runtimeConfig(config),
				({ host, port }) => hostAsker.get()?.(host, port) ?? Promise.resolve(false),
				true,
			);
			setSandboxActive(true);
			lastError = undefined;
			ctx.ui.setStatus(STATUS_KEYS.sandbox, ctx.ui.theme.fg("accent", "🔒 sandbox"));
		} catch (err) {
			setSandboxActive(false);
			lastError = err instanceof Error ? err.message : String(err);
			ctx.ui.setStatus(STATUS_KEYS.sandbox, ctx.ui.theme.fg("error", "🔓 sandbox FAILED"));
			ctx.ui.notify(
				config.failIfUnavailable
					? `Sandbox initialization failed — bash is BLOCKED while sandbox.failIfUnavailable is set: ${lastError}`
					: `Sandbox initialization failed — bash commands run UNSANDBOXED: ${lastError}`,
				"error",
			);
		}
		publishPosture();
	}

	async function deactivate(ctx: ExtensionContext): Promise<void> {
		if (isSandboxActive() && runtime) {
			try {
				await runtime.SandboxManager.reset();
			} catch {
				// Ignore cleanup errors
			}
		}
		if (sessionTmp) {
			rmSync(sessionTmp, { recursive: true, force: true });
			if (process.env.CLAUDE_CODE_TMPDIR === sessionTmp) delete process.env.CLAUDE_CODE_TMPDIR;
			sessionTmp = undefined;
		}
		setSandboxActive(false);
		ctx.ui.setStatus(STATUS_KEYS.sandbox, undefined);
		publishPosture();
	}

	pi.on("session_start", async (_event, ctx) => {
		liveCtx = ctx;
		hostAsker.set(askHost);
		setMainSession({
			sendMessage: (message, delivery) => pi.sendMessage(message, delivery),
			appendEntry: (customType, data) => pi.appendEntry(customType, data),
		});
		config = loadConfig(ctx);
		// pi builds a fresh instance of this extension for every session; the last one may
		// have left the runtime running for background shells.
		const carried = keptSandbox.get();
		if (carried.kept) {
			keptSandbox.set({ kept: false });
			runtime ??= await import("@anthropic-ai/sandbox-runtime");
			sessionTmp = carried.sessionTmp;
		}
		if (config.enabled && carried.kept && isSandboxActive()) {
			// Still running for the background shells the last session left (initialize is
			// not idempotent): this session's settings and chip are all it needs.
			runtime?.SandboxManager.updateConfig(runtimeConfig(config));
			ctx.ui.setStatus(STATUS_KEYS.sandbox, ctx.ui.theme.fg("accent", "🔒 sandbox"));
		} else if (config.enabled) {
			await activate(ctx);
			// Claude Code refuses to start when a required sandbox cannot. The refusal in
			// the bash tool stays as the backstop for a session that keeps running.
			if (!isSandboxActive() && config.failIfUnavailable) {
				console.error(`bluclawd: sandbox.failIfUnavailable is set and the sandbox could not start: ${lastError}`);
				// Headless, a graceful shutdown still lets the pending prompt run first;
				// with a UI it is what restores the terminal.
				if (!ctx.hasUI) process.exit(1);
				// pi exits 0 after a shutdown; the exit code must still report the failure.
				process.once("exit", () => {
					process.exitCode = 1;
				});
				ctx.shutdown();
				return;
			}
		} else if (isSandboxActive()) {
			await deactivate(ctx);
		}
		publishPosture();
		// Subagent children build their bash on these (child-bash.ts): the same
		// sandbox, the same strict refusal, so delegation is not a way around either.
		publishChildBash({
			operations: operationsFor,
			refusal: () => strictRefusalReason(config, isSandboxActive(), lastError),
			shellPath,
			commandPrefix,
		});
	});

	pi.on("session_shutdown", async (event, ctx) => {
		// Background shells outlive a /clear or a session switch (Claude Code): tearing the
		// sandbox down would pull its network proxy and $TMPDIR out from under them. The
		// next session_start finds it still running and keeps it.
		const switching = event.reason === "new" || event.reason === "resume" || event.reason === "fork";
		clearMainSession();
		if (switching && isSandboxActive() && backgroundBashJobs.list().some((job) => !job.exit)) {
			keptSandbox.set({ kept: true, sessionTmp });
			return;
		}
		await deactivate(ctx);
	});

	async function setEnabled(ctx: ExtensionContext, on: boolean): Promise<void> {
		config.enabled = on;
		// SandboxManager.initialize is not idempotent (on Linux it starts a second
		// network bridge without stopping the first).
		if (on && !isSandboxActive()) await activate(ctx);
		if (!on) await deactivate(ctx);
	}

	/**
	 * The sandbox is a switch: on, the model's shell commands run confined (and
	 * without a prompt); off, they run as usual. The choice is saved per project,
	 * never in an untrusted one. The finer settings keys still apply when written.
	 */
	pi.registerCommand("sandbox", {
		description: "Turn the bash sandbox on or off (/sandbox [on|off])",
		handler: async (args, ctx) => {
			let arg = (args ?? "").trim().toLowerCase();
			if (!arg) {
				const choice = await ctx.ui.select(`Sandbox (currently ${isSandboxActive() ? "on" : "off"})`, [
					"On",
					"Off",
				]);
				if (!choice) return;
				arg = choice.toLowerCase();
			}
			if (arg !== "on" && arg !== "off") {
				ctx.ui.notify("Usage: /sandbox [on|off]", "warning");
				return;
			}
			const on = arg === "on";
			await setEnabled(ctx, on);
			// A sandbox that failed to start has already said why.
			if (on && !isSandboxActive()) return;
			let where = "for this session only (the project is not trusted, so nothing was saved)";
			if (ctx.isProjectTrusted()) {
				await setProjectSandboxKeys(ctx.cwd, { enabled: on }, true);
				where = `and saved to ${CONFIG_DIR_NAME}/settings.json`;
			}
			ctx.ui.notify(`Sandbox ${on ? "on 🔒" : "off"} ${where}.`, "info");
		},
	});
}

const sandboxExtension: InlineExtension = { name: "sandbox", factory };

export default sandboxExtension.factory;
