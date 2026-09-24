/**
 * Token counts and billing, for the welcome banner (branding) and `/status`
 * (diagnostics), which load in separate module graphs.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Format token counts for compact display (same thresholds as pi's own footer). */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Providers billed by subscription despite API-key auth, so pi's OAuth rule never sees them. */
const BUILTIN_SUBSCRIPTION_PROVIDERS: readonly string[] = ["kimi-coding", "opencode-go"];

/**
 * Whether the active model is billed by subscription rather than per token —
 * pi's own footer rule (OAuth to a provider whose OAuth flow is a subscription)
 * plus the built-in subscription providers above.
 */
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
