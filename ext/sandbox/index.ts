import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type InlineExtension,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { denyRules, invalidDenyScopes } from "../_shared/settings.ts";
import { readSettings, startupSettings } from "../_shared/startup-settings.ts";
import { timed } from "../_shared/timing.ts";
import {
	agentDirs,
	globalSandboxSetting,
	ownAndDefaultServerDirs,
	runtimeConfig,
	SANDBOX_SETTINGS_CHANGED,
	saveSandboxEnabled,
} from "./config.ts";
import { prepareReaper } from "./reaper.ts";
import {
	type AskNetwork,
	forgetAllowedHosts,
	markSandboxUnavailable,
	noteHostAllowed,
	resetBashWrapOnLoad,
	type SandboxStatus,
	sandboxStatus,
	sandboxWraps,
	startSandbox,
	stopSandbox,
} from "./runtime.ts";

export function networkAsker(context: () => ExtensionContext | undefined): { ask: AskNetwork; forget(): void } {
	const answers = new Map<string, Promise<boolean>>();
	let lastDialogSettled: Promise<unknown> = Promise.resolve();
	return {
		ask: ({ host, port }) => {
			const target = port === undefined ? host : `${host}:${port}`;
			let answer = answers.get(target);
			if (!answer) {
				answer = lastDialogSettled.then(async () => {
					// pi throws when an extension touches the ctx of a replaced session.
					try {
						const ctx = context();
						if (!ctx?.hasUI) return false;
						const allowed = await ctx.ui.confirm(
							"Network access",
							`Allow the model's commands to reach ${target} for this session?`,
						);
						if (allowed) noteHostAllowed(target);
						return allowed;
					} catch {
						return false;
					}
				});
				lastDialogSettled = answer;
				answers.set(target, answer);
			}
			return answer;
		},
		forget: () => {
			answers.clear();
			forgetAllowedHosts();
		},
	};
}

function notifyUnavailable(ctx: ExtensionContext, status: SandboxStatus): void {
	if (status.kind !== "unavailable") return;
	ctx.ui.notify(`Sandbox cannot run: ${status.reason}. The model's bash and monitor are refused.`, "warning");
}

function endsBackgroundShells(reason: SessionShutdownEvent["reason"]): boolean {
	return reason === "quit";
}

function factory(pi: ExtensionAPI): void {
	resetBashWrapOnLoad();
	let ctx: ExtensionContext | undefined;
	let globalSettingsUnreadable = false;
	const asker = networkAsker(() => ctx);

	async function applySettings(startCtx: ExtensionContext, startEvent?: SessionStartEvent): Promise<void> {
		ctx = startCtx;
		asker.forget();
		try {
			const { settings: sm, errors } = startEvent ? startupSettings(startEvent, startCtx) : readSettings(startCtx);
			const globalError = errors.find(({ scope }) => scope === "global");
			globalSettingsUnreadable = globalError !== undefined;
			if (globalError) {
				throw new Error(`${globalError.path ?? "global settings"} could not be read or parsed`);
			}
			const setting = globalSandboxSetting(sm);
			if (setting.kind === "off") {
				await stopSandbox();
				return;
			}
			if (setting.kind === "invalid") throw new Error(setting.reason);
			const projectError = errors.find(({ scope }) => scope === "project");
			if (projectError) {
				throw new Error(`${projectError.path ?? "project settings"} could not be read or parsed`);
			}
			const invalidDenyScope = invalidDenyScopes(sm)[0];
			if (invalidDenyScope) {
				const dir = invalidDenyScope === "global" ? getAgentDir() : join(startCtx.cwd, CONFIG_DIR_NAME);
				throw new Error(`${join(dir, "settings.json")}: permissions.deny is not a list of rules`);
			}
			const status = await startSandbox(
				runtimeConfig(
					setting.settings,
					denyRules(sm),
					startCtx.cwd,
					homedir(),
					tmpdir(),
					ownAndDefaultServerDirs(),
					agentDirs(),
				),
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

	pi.on("session_start", async (event, startCtx) => applySettings(startCtx, event));

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
				pi.events.emit(SANDBOX_SETTINGS_CHANGED, undefined);
				await applySettings(commandCtx);
			}
			const status = sandboxStatus();
			if (status.kind === "unavailable") {
				if (action === "status") notifyUnavailable(commandCtx, status);
				return;
			}
			commandCtx.ui.notify(
				`Sandbox: ${status.kind === "ready" ? "on" : "off"}.${status.kind === "ready" && status.filesystemDisabled ? " Filesystem protection is off (sandbox.filesystem.disabled)." : ""}${status.kind === "ready" && !sandboxWraps() ? " Enable bluclawd's background-bash extension; bash is blocked without it." : ""}${action !== "status" ? " Saved globally. Restart existing background jobs; they do not change sandbox mode." : ""}`,
				status.kind === "ready" && status.filesystemDisabled ? "warning" : "info",
			);
		},
	});

	pi.on("session_shutdown", async (event) => {
		if (endsBackgroundShells(event.reason)) await stopSandbox();
	});

	pi.on("tool_call", async (event): Promise<ToolCallEventResult | undefined> => {
		const status = sandboxStatus();
		if (status.kind === "off") return undefined;
		if (status.kind === "unavailable" && (event.toolName === "bash" || event.toolName === "monitor")) {
			return { block: true, reason: `Sandbox cannot run: ${status.reason}.` };
		}
		if (event.toolName === "powershell" && !globalSettingsUnreadable) {
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
export default timed("sandbox", sandboxExtension.factory);
