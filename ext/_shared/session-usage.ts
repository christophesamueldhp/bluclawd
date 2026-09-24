/**
 * Session spend and how it is billed, for `/usage` (statusline) and `/status`
 * (diagnostics), which load in separate module graphs.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sharedRef } from "./global-state.ts";

/** Format token counts for compact display (same thresholds as pi's own footer). */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export type SessionTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate: number | undefined;
};

/** Providers billed by subscription despite API-key auth, so pi's OAuth rule never sees them. */
const BUILTIN_SUBSCRIPTION_PROVIDERS: readonly string[] = ["kimi-coding", "opencode-go"];

/**
 * `statusline.subscriptionProviders` from settings. A sharedRef, not a module
 * `let`: `diagnostics` imports this file for `/status` inside its own module
 * graph and would otherwise never see what `statusline` set.
 */
const configuredSubscriptionProviders = sharedRef<readonly string[]>("statusline.subscriptionProviders", []);

export function setSubscriptionProviders(providers: readonly string[]): void {
	configuredSubscriptionProviders.set([...providers]);
}

/**
 * Whether the active model is billed by subscription rather than per token —
 * pi's own footer rule (OAuth to a provider whose OAuth flow is a subscription)
 * plus the built-in and configured subscription providers above.
 */
export function isUsingSubscription(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	if (!model) return false;
	if (BUILTIN_SUBSCRIPTION_PROVIDERS.includes(model.provider)) return true;
	if (configuredSubscriptionProviders.get().includes(model.provider)) return true;
	try {
		return (
			ctx.modelRegistry.isUsingOAuth(model) &&
			ctx.modelRegistry.getProvider(model.provider)?.auth?.oauth?.isSubscription === true
		);
	} catch {
		return false;
	}
}

export function sumSessionUsage(ctx: ExtensionContext): SessionTotals {
	const totals: SessionTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		latestCacheHitRate: undefined,
	};
	const add = (usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: { total: number };
	}) => {
		totals.input += usage.input;
		totals.output += usage.output;
		totals.cacheRead += usage.cacheRead;
		totals.cacheWrite += usage.cacheWrite;
		totals.cost += usage.cost.total;
	};
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			add(entry.message.usage);
			const promptTokens =
				entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
			totals.latestCacheHitRate =
				promptTokens > 0 ? (entry.message.usage.cacheRead / promptTokens) * 100 : undefined;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			add(entry.message.usage);
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			add(entry.usage);
		}
	}
	return totals;
}
