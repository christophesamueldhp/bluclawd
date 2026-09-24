/**
 * Billing, for `/status` (diagnostics).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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
