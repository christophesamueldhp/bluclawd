/**
 * Runs the model's shell commands in Anthropic's sandbox runtime when global settings set
 * `sandbox.enabled`: the OS keeps them from reading what a `Read` rule denies, from writing
 * outside the project and temp, and from reaching a host the user has not allowed.
 *
 * Starts the sandbox each session (runtime.ts holds it; background-bash runs bash and monitor
 * through it), asks before a command reaches an unlisted host, and blocks pi's powershell tool,
 * which does not run through the sandbox, and bash when background-bash is not loaded. Registered
 * right after permissions, so a deny rule still blocks a call first.
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
import type { SubagentCommandOwner } from "../_shared/subagent-commands.ts";
import { runtimeConfig, sandboxSetting, saveSandboxEnabled } from "./config.ts";
import { prepareReaper } from "./reaper.ts";
import {
	type AskNetwork,
	forgetWrappedExec,
	markSandboxUnavailable,
	runningCommands,
	type SandboxStatus,
	sandboxStatus,
	sandboxWraps,
	startSandbox,
	stopSandbox,
} from "./runtime.ts";

const SUBAGENT_NETWORK_REASON =
	"reaching this host needs the user's approval, which only the orchestrator can ask for; the orchestrator has been told. Do not retry; continue without it or wait for the orchestrator.";

/**
 * Asks the user once per host and port per session, one dialog at a time; no UI denies. Subagents
 * never ask the user, so a host not yet answered is denied without a dialog and reported to the
 * orchestrator when a subagent's command asks. So is an ask naming no running command while any
 * subagent's command runs, since a command presents its own id and a subagent's can drop it. These
 * denials are not remembered.
 */
export function networkAsker(
	context: () => ExtensionContext | undefined,
	commands: () => ReadonlyMap<string, SubagentCommandOwner | undefined> = runningCommands,
): { ask: AskNetwork; forget(): void } {
	const answers = new Map<string, Promise<boolean>>();
	// pi's dialog replaces an open one without settling it, so a dialog opens only after the last settled.
	let chain: Promise<unknown> = Promise.resolve();
	return {
		ask: ({ host, port, commandId }) => {
			const target = port === undefined ? host : `${host}:${port}`;
			let answer = answers.get(target);
			const running = commands();
			const owners = commandId !== undefined && running.has(commandId) ? [running.get(commandId)] : running.values();
			const suspects = [...new Set(owners)].filter((owner) => owner !== undefined);
			if (!answer && suspects.length > 0) {
				suspects[0].reportNetworkDenied(
					target,
					suspects.map((owner) => owner.name),
				);
				return Promise.resolve({ allow: false, reason: SUBAGENT_NETWORK_REASON });
			}
			if (!answer) {
				answer = chain.then(async () => {
					// pi throws when an extension touches the ctx of a replaced session.
					try {
						const ctx = context();
						if (!ctx?.hasUI) return false;
						return await ctx.ui.confirm(
							"Network access",
							`Allow the model's commands to reach ${target} for this session?`,
						);
					} catch {
						return false;
					}
				});
				chain = answer;
				answers.set(target, answer);
			}
			return answer;
		},
		forget: () => answers.clear(),
	};
}

function notifyUnavailable(ctx: ExtensionContext, status: SandboxStatus): void {
	if (status.kind !== "unavailable") return;
	ctx.ui.notify(
		`Sandbox is on but cannot run: ${status.reason}. The model's bash and monitor are refused.`,
		"warning",
	);
}

function factory(pi: ExtensionAPI): void {
	// Extensions load again on /reload, sandbox before background-bash: a background-bash that is
	// no longer loaded must not leave its earlier wrap recorded.
	forgetWrappedExec();
	let ctx: ExtensionContext | undefined;
	const asker = networkAsker(() => ctx);

	async function applySettings(startCtx: ExtensionContext): Promise<void> {
		ctx = startCtx;
		asker.forget();
		try {
			const sm = SettingsManager.create(startCtx.cwd, undefined, { projectTrusted: startCtx.isProjectTrusted() });
			// pi reads an unparseable settings file as empty, which reads as the sandbox being off.
			for (const { path, scope } of sm.drainErrors()) {
				if (scope === "global")
					startCtx.ui.notify(`Sandbox is off: ${path ?? "global settings"} could not be read.`, "warning");
			}
			const setting = sandboxSetting(sm);
			if (setting.kind === "off") {
				await stopSandbox();
				return;
			}
			const status =
				setting.kind === "invalid"
					? markSandboxUnavailable(setting.reason)
					: await startSandbox(
							runtimeConfig(setting.settings, denyRules(sm), startCtx.cwd, homedir(), tmpdir()),
							asker.ask,
						);
			notifyUnavailable(startCtx, status);
			const problem = status.kind === "ready" ? await prepareReaper() : undefined;
			if (problem)
				startCtx.ui.notify(
					`Sandbox cannot end a command's escaped descendants with it: ${problem}. Commands still run; restart pi once it is fixed.`,
					"warning",
				);
		} catch (error) {
			notifyUnavailable(startCtx, markSandboxUnavailable(error instanceof Error ? error.message : String(error)));
		}
	}

	pi.on("session_start", async (_event, startCtx) => applySettings(startCtx));

	pi.registerCommand("sandbox", {
		description: "Manage the global shell sandbox (/sandbox [on|off|status])",
		getArgumentCompletions: (prefix) =>
			["on", "off", "status"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, commandCtx) => {
			let action = args.trim();
			if (!action && commandCtx.hasUI) {
				const status = sandboxStatus();
				const choice = await commandCtx.ui.select(`Sandbox: ${status.kind}`, ["Status", "Turn on", "Turn off"]);
				if (choice === undefined) return;
				action = choice === "Turn on" ? "on" : choice === "Turn off" ? "off" : "status";
			}
			if (!action) action = "status";
			if (!["on", "off", "status"].includes(action)) {
				commandCtx.ui.notify("Usage: /sandbox [on|off|status]", "warning");
				return;
			}
			if (action !== "status") {
				await commandCtx.waitForIdle();
				try {
					saveSandboxEnabled(action === "on");
				} catch (error) {
					commandCtx.ui.notify(
						`Could not save sandbox settings: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					return;
				}
				await applySettings(commandCtx);
			}
			const status = sandboxStatus();
			if (status.kind === "unavailable") {
				if (action === "status") notifyUnavailable(commandCtx, status);
				return;
			}
			commandCtx.ui.notify(
				`Sandbox: ${status.kind === "ready" ? "on" : "off"}.${status.kind === "ready" && !sandboxWraps() ? " Enable bluclawd's background-bash extension; bash is blocked without it." : ""}${action !== "status" ? " Saved globally. Restart existing background jobs; they do not change sandbox mode." : ""}`,
				"info",
			);
		},
	});

	// Background shells outlive /new, /resume and /fork, so only quitting takes the sandbox down.
	pi.on("session_shutdown", async (event) => {
		if (event.reason === "quit") await stopSandbox();
	});

	pi.on("tool_call", async (event): Promise<ToolCallEventResult | undefined> => {
		if (sandboxStatus().kind === "off") return undefined;
		if (event.toolName === "powershell") {
			return { block: true, reason: "The sandbox is on and powershell does not run inside it; use bash." };
		}
		if (event.toolName === "bash" && !sandboxWraps()) {
			return {
				block: true,
				reason:
					"The sandbox is on but bluclawd's bash, which runs inside it, is not loaded; enable bluclawd's background-bash extension.",
			};
		}
		return undefined;
	});
}

const sandboxExtension: InlineExtension = { name: "sandbox", factory };
export default sandboxExtension.factory;
