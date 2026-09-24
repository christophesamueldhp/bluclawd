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
	createBashTool,
	createLocalBashOperations,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { type BackgroundJobInfo, backgroundBashJobs } from "../_shared/background-bash.ts";
import { detachableExec, ShellDetachedError } from "../_shared/foreground-shells.ts";
import { EVENT_DELIVERY, shouldNotifyExit, taskExitMessage, taskStallMessage } from "../_shared/monitor-events.ts";
import * as forkSettings from "../_shared/settings.ts";
import { addProjectRule, setProjectSandboxKeys } from "../_shared/settings-write.ts";
import { STATUS_KEYS } from "../_shared/status-keys.ts";
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

/**
 * The parameters bluclawd adds to pi's bash tool. Kept next to the
 * registration that owns the tool name so the set cannot drift apart.
 */
const BASH_EXTRA_PARAMS = Type.Object({
	description: Type.Optional(
		Type.String({
			description:
				"Short human-readable summary of what this command does (5-10 words), shown to the user in the UI.",
		}),
	),
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"Run the command in the background and return immediately with a task id and the file its output is written to. You are notified once when it exits; read the output file with the read tool, or check with task_output; stop it with task_stop.",
		}),
	),
	dangerouslyDisableSandbox: Type.Optional(
		Type.Boolean({
			description:
				"Set to true to retry a command OUTSIDE the OS sandbox after a sandboxed run failed with <sandbox_violations>. The user is asked first. Never use it pre-emptively.",
		}),
	),
});

/** How much of a command's output is kept to look for a denial message. */
const DENIAL_SCAN_BYTES = 4096;
/** How long a failed command waits for the violation monitor to catch up. */
const VIOLATION_WAIT_MS = 400;
const VIOLATION_POLL_MS = 50;
/** Where the runtime allows sandboxed temp writes by default. */
const SESSION_TMP_ROOT = "/tmp/claude";

type SandboxRuntime = typeof import("@anthropic-ai/sandbox-runtime");

/**
 * What the model reads when a command goes to the background, in Claude Code's words:
 * at the start, by Ctrl+B (`moved: "user"`), or at its timeout (`moved: seconds`).
 */
function backgroundStartText(job: BackgroundJobInfo, moved?: "user" | number): string {
	const file = job.outputFile ? ` Output is being written to: ${job.outputFile}.` : "";
	const follow = ` You will be notified when it completes. To check interim output, use read on that file path.`;
	if (moved === "user") return `Command was manually backgrounded by user with ID: ${job.id}.${file}`;
	if (typeof moved === "number") {
		return `Command did not complete within its ${moved}s timeout and was moved to the background (ID: ${job.id}).${file}${follow}`;
	}
	return `Command running in background with ID: ${job.id}.${file}${follow}`;
}

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

	// Override the built-in bash tool. When the sandbox is inactive this
	// delegates to an unmodified bash tool with the same settings-derived
	// options the session would have used.
	//
	// This one registration is also where `run_in_background` lives. The fork
	// branch put that parameter in pi's own bash.ts, so the sandbox's
	// createBashTool() call inherited it; here only one extension may own the
	// tool name, so the two features share this registration rather than fight
	// over it. Keep them together if either changes.
	const baseBash = createBashTool(localCwd);
	pi.registerTool({
		...baseBash,
		parameters: Type.Object({ ...baseBash.parameters.properties, ...BASH_EXTRA_PARAMS.properties }),
		async execute(id, params, signal, onUpdate, ctx) {
			const { description, run_in_background, dangerouslyDisableSandbox, ...rest } = params as Static<
				typeof BASH_EXTRA_PARAMS
			> &
				Record<string, unknown>;
			const command = String(rest.command ?? "");

			const refusal = strictRefusalReason(config, isSandboxActive(), lastError);
			if (refusal) {
				return { content: [{ type: "text", text: refusal }], isError: true, details: undefined };
			}

			const ops = operationsFor(command, dangerouslyDisableSandbox === true);

			const owner = ctx?.sessionManager?.getSessionId();
			// One notification on exit, so `until ...; do sleep 1; done` in the
			// background is the single-notification recipe, as in Claude Code.
			const notifyExit = (finished: BackgroundJobInfo) => {
				if (!shouldNotifyExit(finished)) return;
				pi.sendMessage(taskExitMessage(finished, id), EVENT_DELIVERY);
			};
			const notifyStall = (job: BackgroundJobInfo, tail: string) =>
				pi.sendMessage(taskStallMessage(job, tail, id), EVENT_DELIVERY);

			if (run_in_background) {
				// The job's own lifetime owns the process: the tool call's signal is
				// deliberately NOT attached, since backgrounding means outliving this
				// call. Operations match the foreground path, so sandboxing applies.
				const job = backgroundBashJobs.start({
					command,
					cwd: localCwd,
					timeout: typeof rest.timeout === "number" ? rest.timeout : undefined,
					description,
					owner,
					exec: ops.exec,
					onExit: notifyExit,
					onStall: notifyStall,
				});
				return { content: [{ type: "text", text: backgroundStartText(job) }], details: undefined };
			}

			// Ctrl+B can move this call to the background mid-flight (background-bash owns the key).
			const detachable = detachableExec(ops.exec, { description, owner, onExit: notifyExit, onStall: notifyStall });
			const tool = createBashTool(localCwd, { commandPrefix, shellPath, operations: { exec: detachable } });
			try {
				return await tool.execute(id, rest as never, signal, onUpdate);
			} catch (err) {
				if (err instanceof ShellDetachedError) {
					const text = backgroundStartText(err.job, err.timeout ?? "user");
					return { content: [{ type: "text", text }], details: undefined };
				}
				throw err;
			}
		},
	});

	// The monitor is the third shell path the model drives (tool, background job,
	// monitor): same refusal, same operations, so the sandbox covers it too.
	pi.registerTool(
		createMonitorTool({
			sendMessage: (message, options) => pi.sendMessage(message, options),
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
			await runtime.SandboxManager.initialize(runtimeConfig(config), ({ host, port }) => askHost(host, port), true);
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
		config = loadConfig(ctx);
		if (config.enabled) {
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

	pi.on("session_shutdown", async (_event, ctx) => {
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
