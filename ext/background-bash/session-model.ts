/**
 * A resumed session's model, picked again when pi lost it. pi 1.5.2 restores it only when its provider's auth was
 * already checked, and one an extension registers may not be yet: the session is left on pi's placeholder model,
 * `unknown`, and a wake-up's turn, which starts as soon as the session opens, fails (#318).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Entry = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number];
type Selection = { provider: string; modelId: string };

/** pi's own placeholder: a session it could not give a model has this one. */
const PLACEHOLDER_PROVIDER = "unknown";
/** The api of a virtual model, which routes each request to a physical one. */
const VIRTUAL_MODEL_API = "pi-virtual";

/** The last entry of `branch` before index `end` that is of type `type`. */
function lastOfType<T extends Entry["type"]>(branch: readonly Entry[], type: T, end = branch.length) {
	for (let i = end - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === type) return entry as Extract<Entry, { type: T }>;
	}
	return undefined;
}

/**
 * The model a session branch records, as pi picks it on resume: the last model change, unless a physical model answered
 * since; that one, unless the change before it was to a virtual model, which still holds.
 */
export function branchSelection(
	branch: readonly Entry[],
	isVirtual: (selection: Selection) => boolean,
): Selection | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "model_change") return { provider: entry.provider, modelId: entry.modelId };
		if (entry.type !== "message" || entry.message.role !== "assistant" || entry.message.api === VIRTUAL_MODEL_API) {
			continue;
		}
		const change = lastOfType(branch, "model_change", i);
		const changed = change && { provider: change.provider, modelId: change.modelId };
		return changed && isVirtual(changed)
			? changed
			: { provider: entry.message.provider, modelId: entry.message.model };
	}
	return undefined;
}

/**
 * Gives the session the model it recorded, with its thinking level, once its provider's auth is checked. Nothing changes
 * when pi gave it a model, or when that model is no longer registered or its provider has no auth: pi's own fallback stands.
 */
export async function restoreSessionModel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (ctx.model?.provider !== PLACEHOLDER_PROVIDER) return;
	const branch = ctx.sessionManager.getBranch();
	const selection = branchSelection(
		branch,
		({ provider, modelId }) => ctx.modelRegistry.find(provider, modelId)?.api === VIRTUAL_MODEL_API,
	);
	const model = selection && ctx.modelRegistry.find(selection.provider, selection.modelId);
	if (!model) return;
	try {
		await ctx.modelRegistry.refresh({ providers: [model.provider], allowNetwork: false });
		if (!(await pi.setModel(model))) return;
	} catch {
		return;
	}
	// Switching models takes the default thinking level; the session's own is the one it recorded.
	const thinking = lastOfType(branch, "thinking_level_change");
	if (thinking) {
		pi.setThinkingLevel(thinking.thinkingLevel as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
	}
}
