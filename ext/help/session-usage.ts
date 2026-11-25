import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RunUsageLedger } from "../subagents/storage.ts";

export function subagentUsageSummary(ledger: Pick<RunUsageLedger, "runCount" | "usage">): string | undefined {
	if (ledger.runCount === 0) return undefined;
	const cost = ledger.usage.hasUnknownCost ? "cost unknown" : `estimated cost $${ledger.usage.cost.total.toFixed(6)}`;
	return `${ledger.runCount} runs, ${ledger.usage.totalTokens} tokens, ${cost} — excluded from /session totals`;
}

const BUILTIN_SUBSCRIPTION_PROVIDERS: readonly string[] = ["kimi-coding", "opencode-go"];

export function isUsingSubscription(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	if (!model) return false;
	if (BUILTIN_SUBSCRIPTION_PROVIDERS.includes(model.provider)) return true;
	try {
		return (
			ctx.modelRegistry.isUsingOAuth(model) &&
			ctx.modelRegistry.getProvider(model.provider)?.auth?.oauth?.isSubscription === true
		);
	} catch {
		return false;
	}
}
