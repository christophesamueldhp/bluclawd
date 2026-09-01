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
 *
 * The decider/notifier pair is stored via {@link sharedRef}, not a plain
 * module-level `let`: `hooks` and `permissions` are separate top-level
 * extensions, each with its own module graph under pi's loader (`moduleCache:
 * false`), so a plain `let` would leave permissions' copy of `decider` always
 * undefined — `decidePermissionViaHooks` silently returning undefined on every
 * call, as if no PreToolUse hook were ever configured. That fails toward more
 * prompts when a hook wants to auto-allow, but toward FEWER when a hook wants
 * to force "ask" on something permissions' own rules would otherwise
 * auto-allow — a configured hook silently stops gating at all.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sharedRef } from "../_shared/global-state.ts";

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

interface Bridge {
	decider: HookPermissionDecider;
	notifier: HookPromptNotifier;
}

const ref = sharedRef<Bridge | undefined>("hooks.permissionBridge", undefined);

export function setHookPermissionBridge(bridge: Bridge | undefined): void {
	ref.set(bridge);
}

/** Ask PreToolUse hooks to decide; undefined = no hooks configured / no decision. */
export async function decidePermissionViaHooks(
	request: HookPermissionRequest,
	ctx: ExtensionContext,
): Promise<HookPermissionDecision | undefined> {
	const bridge = ref.get();
	if (!bridge) return undefined;
	try {
		return await bridge.decider(request, ctx);
	} catch {
		return undefined; // a broken hook must never wedge the permission gate
	}
}

/** Tell Notification hooks a permission prompt is being shown. Never throws. */
export function notifyPermissionPrompt(message: string, ctx: ExtensionContext): void {
	try {
		ref.get()?.notifier(message, ctx);
	} catch {
		// Notification is best-effort
	}
}
