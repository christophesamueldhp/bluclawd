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
import { runtimeConfig, sandboxSetting } from "./config.ts";
import {
	type AskNetwork,
	markSandboxUnavailable,
	type SandboxStatus,
	sandboxStatus,
	sandboxWraps,
	startSandbox,
	stopSandbox,
} from "./runtime.ts";

/** Asks the user once per host and port per session, one dialog at a time; no UI denies. */
export function networkAsker(context: () => ExtensionContext | undefined): { ask: AskNetwork; forget(): void } {
	const answers = new Map<string, Promise<boolean>>();
	// pi's dialog replaces an open one without settling it, so a dialog opens only after the last settled.
	let chain: Promise<unknown> = Promise.resolve();
	return {
		ask: ({ host, port }) => {
			const target = port === undefined ? host : `${host}:${port}`;
			let answer = answers.get(target);
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
	let ctx: ExtensionContext | undefined;
	const asker = networkAsker(() => ctx);

	pi.on("session_start", async (_event, startCtx) => {
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
		} catch (error) {
			notifyUnavailable(startCtx, markSandboxUnavailable(error instanceof Error ? error.message : String(error)));
		}
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
