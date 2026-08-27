/**
 * Model Controls core extension.
 *
 * - /effort <level>       Set thinking effort (off|minimal|low|medium|high|xhigh).
 * - /fast                 Fast mode: switch to `settings.fastModel` with thinking off.
 *
 * Split out of the former output-styles extension, which bundled these two
 * commands alongside /output-style purely as an implementation convenience.
 *
 * Split fidelity checked (IMPROVEMENT-PLAN.md §4.2, 2026-08-14): diffed this
 * file and its test file against commit 9d7c6bd2d's parent
 * (output-styles/index.ts and its test file) line by line. Byte-identical
 * for every /effort and /fast line; every removed line was /output-style-
 * specific (bundled styles, before_agent_start injection, session_start
 * persistence) and legitimately gone with that command. No behavior or test
 * coverage was lost in the move.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	InlineExtension,
} from "../../../packages/coding-agent/src/core/extensions/types.ts";
import { SettingsManager } from "../../../packages/coding-agent/src/core/settings-manager.ts";
import * as forkSettings from "../_shared/settings.ts";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type Level = (typeof LEVELS)[number];

export function factory(pi: ExtensionAPI): void {
	pi.registerCommand("effort", {
		description: `Set thinking effort: ${LEVELS.join("|")}`,
		handler: async (args, ctx) => {
			const lvl = args.trim() as Level;
			if (!lvl) {
				ctx.ui.notify(`Current effort: ${pi.getThinkingLevel()}. Levels: ${LEVELS.join(", ")}`, "info");
				return;
			}
			if (!LEVELS.includes(lvl)) {
				ctx.ui.notify(`Invalid level "${lvl}". Use: ${LEVELS.join(", ")}`, "error");
				return;
			}
			pi.setThinkingLevel(lvl);
			ctx.ui.notify(`Effort set to ${lvl}.`, "info");
		},
	});

	// Fast-mode toggle state (factory closure — per runner instance). While on,
	// holds what to restore on "/fast off": the pre-fast model + thinking level,
	// and the fast model's identity so model_select can tell our switch from a
	// manual one.
	let fastRestore:
		| {
				model: Parameters<typeof pi.setModel>[0];
				thinkingLevel: ReturnType<typeof pi.getThinkingLevel>;
		  }
		| undefined;
	let fastModelKey: string | undefined;

	function setFastChip(ctx: ExtensionContext, on: boolean): void {
		ctx.ui.setStatus("fast-mode", on ? ctx.ui.theme.fg("warning", "⚡ fast") : undefined);
	}

	async function disableFastMode(ctx: ExtensionContext): Promise<void> {
		if (!fastRestore) {
			ctx.ui.notify("Fast mode is not on.", "info");
			return;
		}
		const restore = fastRestore;
		fastRestore = undefined;
		fastModelKey = undefined;
		setFastChip(ctx, false);
		const ok = await pi.setModel(restore.model);
		if (!ok) {
			ctx.ui.notify(`Fast mode off: could not restore ${restore.model.provider}/${restore.model.id}.`, "warning");
			return;
		}
		pi.setThinkingLevel(restore.thinkingLevel);
		ctx.ui.notify(`Fast mode off: back to ${restore.model.provider}/${restore.model.id}.`, "info");
	}

	pi.registerCommand("fast", {
		description: "Toggle fast mode (quick model, thinking off): /fast [on|off]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg !== "" && arg !== "on" && arg !== "off") {
				ctx.ui.notify("Usage: /fast [on|off]", "warning");
				return;
			}
			if (arg === "off" || (arg === "" && fastRestore)) {
				await disableFastMode(ctx);
				return;
			}
			if (fastRestore) {
				ctx.ui.notify("Fast mode is already on.", "info");
				return;
			}

			// fastModel switches the LIVE session model: project-scope settings apply
			// only when the user trusted the project (core-ext audit rule).
			const fastModel = forkSettings.fastModel(
				SettingsManager.create(ctx.cwd, undefined, {
					projectTrusted: ctx.isProjectTrusted(),
				}),
			);
			if (!fastModel) {
				ctx.ui.notify(
					'Fast mode is not configured. Set "fastModel": "<provider>/<model-id>" in settings.json (e.g. "opencode-go/deepseek-v4-flash").',
					"warning",
				);
				return;
			}

			const slash = fastModel.indexOf("/");
			if (slash <= 0 || slash === fastModel.length - 1) {
				ctx.ui.notify(`Fast mode: invalid fastModel "${fastModel}" (expected "provider/model-id").`, "error");
				return;
			}
			const provider = fastModel.slice(0, slash);
			const modelId = fastModel.slice(slash + 1);

			const model = ctx.modelRegistry.find(provider, modelId);
			if (!model) {
				ctx.ui.notify(`Fast mode: model ${fastModel} not found`, "warning");
				return;
			}

			// Capture the restore point BEFORE switching.
			const previous = ctx.model;
			const previousThinking = pi.getThinkingLevel();

			const ok = await pi.setModel(model);
			if (!ok) {
				ctx.ui.notify(`Fast mode: no API key for ${fastModel}`, "warning");
				return;
			}

			if (previous) {
				fastRestore = { model: previous, thinkingLevel: previousThinking };
				fastModelKey = `${provider}/${modelId}`;
				setFastChip(ctx, true);
			}
			pi.setThinkingLevel("off");
			ctx.ui.notify(
				`Fast mode: ${fastModel}, thinking off.${previous ? " /fast again to switch back." : ""}`,
				"info",
			);
		},
	});

	// A manual model switch while fast mode is on exits fast mode without
	// restoring anything — the user chose a model; keep it, drop the stale
	// restore point and the chip.
	pi.on("model_select", async (event, ctx) => {
		if (!fastRestore) return;
		if (`${event.model.provider}/${event.model.id}` === fastModelKey) return;
		fastRestore = undefined;
		fastModelKey = undefined;
		setFastChip(ctx, false);
	});
}

const modelControlsExtension: InlineExtension = {
	name: "model-controls",
	factory,
};
export default modelControlsExtension;
