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
 * host asks the user, and a yes holds for the session.
 *
 * Failure posture: if enabled but initialization fails (missing bubblewrap,
 * unsupported platform, ...), bash falls back to UNSANDBOXED execution with a
 * loud status chip and an error notice — unless `sandbox.failIfUnavailable` is
 * set, in which case the model's bash refuses to run at all: the tool,
 * background jobs and the monitor each check strictRefusalReason. The runtime dependency is
 * imported lazily so disabled sessions pay no startup cost.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	createBashTool,
	createLocalBashOperations,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { backgroundBashJobs } from "../_shared/background-bash.ts";
import { EVENT_DELIVERY, shouldNotifyExit, tailOutput, taskExitMessage } from "../_shared/monitor-events.ts";
import * as forkSettings from "../_shared/settings.ts";
import {
	isExcludedCommand,
	resolveSandboxConfig,
	runtimeConfig,
	type SandboxConfig,
	strictRefusalReason,
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
				"Run the command in the background and return immediately with a task id. You are notified once when it exits (with its last lines of output); read more with bash_output; stop it with kill_bash.",
		}),
	),
	dangerouslyDisableSandbox: Type.Optional(
		Type.Boolean({
			description:
				"Set to true to retry a command OUTSIDE the OS sandbox after a sandboxed run failed with <sandbox_violations>. The user is asked first. Never use it pre-emptively.",
		}),
	),
});

/** How much of a finished job's output rides along with its exit notification. */
const EXIT_TAIL_LINES = 20;
const EXIT_TAIL_BYTES = 2048;

/** How much of a command's output is kept to look for a denial message. */
const DENIAL_SCAN_BYTES = 4096;
/** How long a failed command waits for the violation monitor to catch up. */
const VIOLATION_WAIT_MS = 400;
const VIOLATION_POLL_MS = 50;

type SandboxRuntime = typeof import("@anthropic-ai/sandbox-runtime");

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
	// The ask callback is bound once at initialize; the context it prompts through
	// is whichever session is live now.
	let liveCtx: ExtensionContext | undefined;
	// Hosts the user allowed this session (`host:port`), and prompts in flight so
	// N parallel connections to one host raise one dialog, not N.
	const sessionAllowedHosts = new Set<string>();
	const pendingHostPrompts = new Map<string, Promise<boolean>>();

	async function askHost(host: string, port: number): Promise<boolean> {
		const key = `${host}:${port}`;
		if (sessionAllowedHosts.has(key)) return true;
		const pending = pendingHostPrompts.get(key);
		if (pending) return pending;
		const ctx = liveCtx;
		if (!ctx?.hasUI) return false;
		const prompt = ctx.ui
			.confirm(
				"Sandbox: allow network access?",
				`A sandboxed command wants to connect to ${key}.\nAllow it for this session? The command is waiting on your answer and may time out.\nPre-allow hosts with sandbox.network.allowedDomains in settings.json.`,
			)
			.then((yes) => {
				if (yes) sessionAllowedHosts.add(key);
				return yes;
			})
			.catch(() => false)
			.finally(() => pendingHostPrompts.delete(key));
		pendingHostPrompts.set(key, prompt);
		return prompt;
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
		async execute(id, params, signal, onUpdate) {
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

			if (run_in_background) {
				// The job's own lifetime owns the process: the tool call's signal is
				// deliberately NOT attached, since backgrounding means outliving this
				// call. Operations match the foreground path, so sandboxing applies.
				const job = backgroundBashJobs.start({
					command,
					cwd: localCwd,
					timeout: typeof rest.timeout === "number" ? rest.timeout : undefined,
					description,
					exec: ops.exec,
					// One notification on exit, so `until ...; do sleep 1; done` in the
					// background is the single-notification recipe, as in Claude Code.
					onExit: (finished) => {
						if (!shouldNotifyExit(finished)) return;
						const tail = tailOutput(backgroundBashJobs.peek(finished.id) ?? "", EXIT_TAIL_LINES, EXIT_TAIL_BYTES);
						pi.sendMessage(taskExitMessage(finished, tail), EVENT_DELIVERY);
					},
				});
				return {
					content: [
						{
							type: "text",
							text: `Started background task ${job.id}: ${command}\nRead output with bash_output {"task_id":"${job.id}"}; stop it with kill_bash. /tasks lists all background tasks.`,
						},
					],
					details: undefined,
				};
			}

			const tool = createBashTool(localCwd, { commandPrefix, shellPath, operations: ops });
			return tool.execute(id, rest as never, signal, onUpdate);
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
			// The log monitor is what attributes file denials to commands (network
			// denials come from the proxy regardless).
			await runtime.SandboxManager.initialize(runtimeConfig(config), ({ host, port }) => askHost(host, port), true);
			setSandboxActive(true);
			lastError = undefined;
			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", "🔒 sandbox"));
		} catch (err) {
			setSandboxActive(false);
			lastError = err instanceof Error ? err.message : String(err);
			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("error", "🔓 sandbox FAILED"));
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
		setSandboxActive(false);
		ctx.ui.setStatus("sandbox", undefined);
		publishPosture();
	}

	pi.on("session_start", async (_event, ctx) => {
		liveCtx = ctx;
		const sm = SettingsManager.create(ctx.cwd, undefined, {
			projectTrusted: ctx.isProjectTrusted(),
		});
		shellPath = sm.getShellPath();
		commandPrefix = sm.getShellCommandPrefix();
		config = resolveSandboxConfig(forkSettings.sandbox(sm), {
			sandbox: pi.getFlag("sandbox") === true,
			noSandbox: pi.getFlag("no-sandbox") === true,
		});
		if (config.enabled) {
			await activate(ctx);
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

	pi.registerCommand("sandbox", {
		description: "Show or toggle bash sandboxing (/sandbox [on|off])",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();
			if (arg === "on") {
				config.enabled = true;
				// SandboxManager.initialize is not idempotent (on Linux it starts a
				// second network bridge without stopping the first).
				if (!isSandboxActive()) await activate(ctx);
				if (isSandboxActive()) {
					ctx.ui.notify(
						"Sandbox enabled for this session. Persist with sandbox.enabled in settings.json.",
						"info",
					);
				}
				return;
			}
			if (arg === "off") {
				await deactivate(ctx);
				config.enabled = false;
				ctx.ui.notify("Sandbox disabled for this session. Persist with sandbox.enabled in settings.json.", "info");
				return;
			}
			const list = (values: string[] | undefined) => values?.join(", ") || "(none)";
			const lines = [
				`Sandbox: ${isSandboxActive() ? "active 🔒" : config.enabled ? "enabled but NOT active 🔓" : "disabled"}`,
				`On failure: ${config.failIfUnavailable ? "REFUSE to run bash (sandbox.failIfUnavailable)" : "run unsandboxed"}`,
				...(lastError ? [`Last error: ${lastError}`] : []),
				"",
				`Mode: ${config.autoAllowBashIfSandboxed ? "auto-allow (sandboxed commands run without a prompt)" : "regular permissions (sandboxed commands still prompt)"}`,
				`Unsandboxed retry (dangerouslyDisableSandbox): ${config.allowUnsandboxedCommands ? "allowed, goes through the permission flow" : "ignored — strict sandbox mode"}`,
				`Excluded commands (always unsandboxed): ${list(config.excludedCommands)}`,
				"",
				"Network:",
				`  Pre-allowed: ${list(config.network.allowedDomains)}`,
				`  Allowed this session: ${list([...sessionAllowedHosts])}`,
				`  Denied: ${list(config.network.deniedDomains)}`,
				`  Unlisted hosts: ${config.network.strictAllowlist ? "denied (strictAllowlist)" : "ask the user; denied when no one can answer"}`,
				"",
				"Filesystem:",
				`  Deny read: ${list(config.filesystem.denyRead)}`,
				`  Allow write: ${list(config.filesystem.allowWrite)}`,
				`  Deny write: ${list(config.filesystem.denyWrite)}`,
				"",
				"Toggle with /sandbox on|off; configure via the sandbox section in settings.json.",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

const sandboxExtension: InlineExtension = { name: "sandbox", factory };

export default sandboxExtension.factory;
