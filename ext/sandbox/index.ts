/**
 * Sandbox core extension (audit C.1, CC parity §4.2): OS-level sandboxing for
 * bash commands via @anthropic-ai/sandbox-runtime (Seatbelt/sandbox-exec on
 * macOS, bubblewrap on Linux).
 *
 * Opt-in: settings.json `sandbox.enabled` (global+project merge, project only
 * when trusted) or --sandbox; --no-sandbox wins over both. Replaces the
 * built-in bash tool with a variant whose operations wrap each command via
 * SandboxManager.wrapWithSandbox before delegating to pi's standard local
 * shell backend — foreground, background (run_in_background), and user `!`
 * commands all flow through the same operations seam, so all are sandboxed.
 *
 * Failure posture: if enabled but initialization fails (missing bubblewrap,
 * unsupported platform, ...), bash falls back to UNSANDBOXED execution with a
 * loud status chip and an error notice. The runtime dependency is imported
 * lazily so disabled sessions pay no startup cost.
 */

import { type Static, Type } from "typebox";
import type {
	ExtensionAPI,
	ExtensionContext,
	InlineExtension,
} from "../../../packages/coding-agent/src/core/extensions/types.ts";
import { SettingsManager } from "../../../packages/coding-agent/src/core/settings-manager.ts";
import {
	type BashOperations,
	createBashTool,
	createLocalBashOperations,
} from "../../../packages/coding-agent/src/core/tools/bash.ts";
import { backgroundBashJobs } from "../_shared/background-bash.ts";
import * as forkSettings from "../_shared/settings.ts";
import { resolveSandboxConfig, type SandboxConfig } from "./config.ts";
import { buildSandboxFailureNote } from "./failure-note.ts";
import { isSandboxActive, setSandboxActive } from "./state.ts";

/**
 * The two parameters bluclawd adds to pi's bash tool. Kept next to the
 * registration that owns the tool name so the pair cannot drift apart.
 */
const BACKGROUND_BASH_PARAMS = Type.Object({
	description: Type.Optional(
		Type.String({
			description:
				"Short human-readable summary of what this command does (5-10 words), shown to the user in the UI.",
		}),
	),
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"Run the command in the background and return immediately with a task id. Read its output later with bash_output; stop it with kill_bash.",
		}),
	),
});

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

	function sandboxedOperations(): BashOperations {
		const local = createLocalBashOperations({ shellPath });
		return {
			exec: async (command, cwd, options) => {
				if (!runtime) throw new Error("Sandbox runtime not initialized");
				const wrapped = await runtime.SandboxManager.wrapWithSandbox(command);
				const result = await local.exec(wrapped, cwd, options);
				// A failed command may well have been denied by the sandbox; say so,
				// with the limits in force, so the model can adapt instead of retrying
				// the same thing (see failure-note.ts for why the OS violation feed
				// is not used).
				if (result.exitCode !== 0) {
					const note = buildSandboxFailureNote(config);
					if (note) options.onData(Buffer.from(note));
				}
				return result;
			},
		};
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
	const plainBash = () => createBashTool(localCwd, { commandPrefix, shellPath });
	const baseBash = createBashTool(localCwd);
	pi.registerTool({
		...baseBash,
		parameters: Type.Object({ ...baseBash.parameters.properties, ...BACKGROUND_BASH_PARAMS.properties }),
		async execute(id, params, signal, onUpdate) {
			const { description, run_in_background, ...rest } = params as Static<typeof BACKGROUND_BASH_PARAMS> &
				Record<string, unknown>;

			if (run_in_background) {
				// The job's own lifetime owns the process: the tool call's signal is
				// deliberately NOT attached, since backgrounding means outliving this
				// call. Operations match the foreground path, so sandboxing applies.
				const ops = isSandboxActive() ? sandboxedOperations() : createLocalBashOperations();
				const job = backgroundBashJobs.start({
					command: String(rest.command ?? ""),
					cwd: localCwd,
					timeout: typeof rest.timeout === "number" ? rest.timeout : undefined,
					description,
					exec: ops.exec,
				});
				return {
					content: [
						{
							type: "text",
							text: `Started background task ${job.id}: ${rest.command}\nRead output with bash_output {"task_id":"${job.id}"}; stop it with kill_bash. /tasks lists all background tasks.`,
						},
					],
					details: undefined,
				};
			}

			const tool = isSandboxActive()
				? createBashTool(localCwd, {
						commandPrefix,
						shellPath,
						operations: sandboxedOperations(),
					})
				: plainBash();
			return tool.execute(id, rest as never, signal, onUpdate);
		},
	});

	pi.on("user_bash", () => {
		if (!isSandboxActive()) return;
		return { operations: sandboxedOperations() };
	});

	async function activate(ctx: ExtensionContext): Promise<void> {
		if (process.platform !== "darwin" && process.platform !== "linux") {
			setSandboxActive(false);
			lastError = `not supported on ${process.platform}`;
			ctx.ui.notify(`Sandbox not supported on ${process.platform}`, "warning");
			return;
		}
		try {
			runtime ??= await import("@anthropic-ai/sandbox-runtime");
			await runtime.SandboxManager.initialize({
				network: {
					allowedDomains: config.network?.allowedDomains ?? [],
					deniedDomains: config.network?.deniedDomains ?? [],
				},
				filesystem: {
					denyRead: config.filesystem?.denyRead ?? [],
					allowWrite: config.filesystem?.allowWrite ?? [],
					denyWrite: config.filesystem?.denyWrite ?? [],
				},
				ignoreViolations: config.ignoreViolations,
				enableWeakerNestedSandbox: config.enableWeakerNestedSandbox,
			});
			setSandboxActive(true);
			lastError = undefined;
			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", "🔒 sandbox"));
		} catch (err) {
			setSandboxActive(false);
			lastError = err instanceof Error ? err.message : String(err);
			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("error", "🔓 sandbox FAILED"));
			ctx.ui.notify(`Sandbox initialization failed — bash commands run UNSANDBOXED: ${lastError}`, "error");
		}
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
	}

	pi.on("session_start", async (_event, ctx) => {
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
				await activate(ctx);
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
			const lines = [
				`Sandbox: ${isSandboxActive() ? "active 🔒" : config.enabled ? "enabled but NOT active 🔓" : "disabled"}`,
				...(lastError ? [`Last error: ${lastError}`] : []),
				"",
				"Network:",
				`  Allowed: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
				`  Denied: ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
				"",
				"Filesystem:",
				`  Deny read: ${config.filesystem?.denyRead?.join(", ") || "(none)"}`,
				`  Allow write: ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
				`  Deny write: ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
				"",
				"Toggle with /sandbox on|off; configure via the sandbox section in settings.json.",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

const sandboxExtension: InlineExtension = { name: "sandbox", factory };

export default sandboxExtension;
