/**
 * Bridge between the hooks and permissions core extensions (audit B.4).
 *
 * Permissions registers first and gates tool_call before hooks run, so a
 * PreToolUse hook's permissionDecision ("allow" | "ask") could never reach it
 * through event ordering. Instead, permissions calls decidePermissionViaHooks()
 * from inside its ask/auto gates; the hooks extension registers a decider here
 * at session_start that runs the PreToolUse hooks ONCE and caches the outcome
 * by toolCallId, so its own tool_call pass reuses it instead of re-executing
 * hook commands. notifyPermissionPrompt() likewise fans a permission prompt out
 * to Notification hooks (fire-and-forget).
 *
 * Either extension can be disabled independently: with no decider registered,
 * decidePermissionViaHooks returns undefined and permissions behaves as before;
 * with permissions disabled, the hooks extension's own tool_call pass still
 * enforces deny (allow/ask have nothing to act on).
 */

import type { ExtensionContext } from "../../../packages/coding-agent/src/core/extensions/types.ts";

export interface HookPermissionDecision {
	decision: "allow" | "deny" | "ask";
	reason?: string;
}

export interface HookPermissionRequest {
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
}

export type HookPermissionDecider = (
	request: HookPermissionRequest,
	ctx: ExtensionContext,
) => Promise<HookPermissionDecision | undefined>;

export type HookPromptNotifier = (message: string, ctx: ExtensionContext) => void;

let decider: HookPermissionDecider | undefined;
let notifier: HookPromptNotifier | undefined;

export function setHookPermissionBridge(
	bridge: { decider: HookPermissionDecider; notifier: HookPromptNotifier } | undefined,
): void {
	decider = bridge?.decider;
	notifier = bridge?.notifier;
}

/** Ask PreToolUse hooks to decide; undefined = no hooks configured / no decision. */
export async function decidePermissionViaHooks(
	request: HookPermissionRequest,
	ctx: ExtensionContext,
): Promise<HookPermissionDecision | undefined> {
	if (!decider) return undefined;
	try {
		return await decider(request, ctx);
	} catch {
		return undefined; // a broken hook must never wedge the permission gate
	}
}

/** Tell Notification hooks a permission prompt is being shown. Never throws. */
export function notifyPermissionPrompt(message: string, ctx: ExtensionContext): void {
	try {
		notifier?.(message, ctx);
	} catch {
		// Notification is best-effort
	}
}
