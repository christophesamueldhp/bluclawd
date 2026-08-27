/**
 * Hooks protocol (pure, unit-tested) — PLAN.md F2.2.
 *
 * Interprets a single hook command's result against the Claude Code hook protocol
 * without any I/O of its own: `exec` is injected, so every branch is testable with
 * a fake. `index.ts` wires the real `pi.exec` (extended with stdin/env — see
 * core/exec.ts) into `runHook`.
 *
 * Blocking semantics (a PreToolUse / UserPromptSubmit hook can block):
 *  - exit code 2                       ⇒ BLOCK, reason = trimmed stderr
 *  - stdout `{"decision":"block",…}`   ⇒ BLOCK, reason = its `reason` (even on exit 0)
 *  - stdout `{"hookSpecificOutput":{"permissionDecision":"deny",…}}` (Claude Code
 *    form) ⇒ BLOCK, reason = its `permissionDecisionReason`
 *  - stdout `{"continue":false,…}`     ⇒ BLOCK, reason = its `stopReason` (only when
 *    no more specific reason above already set one — see `parseStructured`)
 *  - any other non-zero exit           ⇒ log and continue (NOT a block)
 *  - killed / timed-out                ⇒ log and continue (fail OPEN)
 *
 * Non-blocking output channels (Claude Code parity):
 *  - stdout JSON `hookSpecificOutput.additionalContext` ⇒ returned as
 *    `additionalContext` for the caller to inject (any decision).
 *  - a clean exit-0 run whose stdout is NOT structured JSON ⇒ trimmed stdout is
 *    returned as `stdout` (Claude Code injects it into context for
 *    UserPromptSubmit; index.ts decides per-event what to do with it).
 *  - `permissionDecision: "allow" | "ask"` is returned as `permissionDecision`
 *    (audit B.4): the permissions extension consults PreToolUse hooks through
 *    hooks/permissions-bridge.ts before its ask/auto gates — "allow" clears
 *    them (deny rules and protected paths still win), "ask" forces the prompt.
 *    (IMPROVEMENT-PLAN.md §3.1, re-verified 2026-08-14 against
 *    https://code.claude.com/docs/en/hooks: Claude Code's own contract still
 *    spells this value "ask", not "escalate" — the word does not appear on that
 *    page at all. The plan flagged this as resting on a single earlier
 *    summarized fetch and asked to accept both spellings "to be safe either
 *    way"; the re-check found nothing to accept a synonym for, so nothing was
 *    added here. Re-verify before ever "fixing" this to add `escalate`.)
 *  - stdout `{"systemMessage":"…"}` ⇒ returned as `systemMessage`, shown to the
 *    user regardless of the hook's decision (IMPROVEMENT-PLAN.md §3.2b: `index.ts`
 *    surfaces it via `ctx.ui.notify` for every event, unlike `blocked`/`reason`,
 *    which only the three already-blockable events (PreToolUse, UserPromptSubmit,
 *    PreCompact) ever consult).
 *
 * `continue: false` is Claude Code's universal stop signal, honored here as just
 * another way to set `blocked`/`reason` (via `stopReason`) — it does NOT gain any
 * event a cancel channel that event didn't already have. On the three blockable
 * events above it behaves exactly like `decision: "block"`; on every other event
 * (PostToolUseFailure, SubagentStart/Stop, Notification, Stop, SessionStart/End,
 * PostCompact) the caller never reads this outcome's `blocked` field at all — the
 * same structural gap already documented for `Stop`/`SubagentStop` in
 * `hooks/index.ts`'s header and `docs/features/hooks.md`'s Limitations section, not
 * a new one. `suppressOutput` is intentionally not implemented: Claude Code's own
 * docs say it "has no effect" today.
 *
 * The fail-open on timeout is deliberate and matches Claude Code: a PreToolUse guard
 * that hangs must not permanently wedge the agent. Documented trade-off — a slow or
 * buggy guard fails open rather than blocking forever.
 */

import type { ExecResult } from "@earendil-works/pi-coding-agent";

/** Default per-hook timeout. A hook exceeding this is killed and fails open. */
export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

/** The subset of `pi.exec` / `execCommand` that a hook needs. Injected for testing. */
import type { ExecWithIoOptions } from "../_shared/exec.ts";

export type HookExec = (command: string, args: string[], options?: ExecWithIoOptions) => Promise<ExecResult>;

export interface RunHookOptions {
	/** Per-hook timeout in ms (default {@link DEFAULT_HOOK_TIMEOUT_MS}). */
	timeoutMs?: number;
	/** Optional sink for non-fatal diagnostics (bad regex, non-2 exits, timeouts). */
	log?: (message: string) => void;
}

export interface HookOutcome {
	/** True only for blockable events that the hook chose to block. */
	blocked: boolean;
	/** Human-readable reason to surface when blocked. */
	reason?: string;
	/** Context contributed via stdout JSON `hookSpecificOutput.additionalContext`. */
	additionalContext?: string;
	/** Trimmed non-JSON stdout of a clean exit-0 run (Claude Code injects this for
	 * UserPromptSubmit). Undefined when empty, structured, blocked, or failed. */
	stdout?: string;
	/** hookSpecificOutput.permissionDecision "allow"/"ask" ("deny" surfaces as `blocked`). */
	permissionDecision?: "allow" | "ask";
	/** Top-level `systemMessage`, shown to the user regardless of the hook's decision. */
	systemMessage?: string;
}

/**
 * Does `matcher` apply to `toolName`?
 *
 * - An empty/undefined matcher always matches (session/prompt events, or a tool hook
 *   that opts to match everything).
 * - Otherwise `matcher` is a regex tested against the tool name, case-insensitively
 *   (so a config written against Claude Code's capitalized tool names — "Bash",
 *   "Edit|Write" — still matches pi's lowercase tool names).
 * - An INVALID regex must never crash a tool call: it is treated as no-match and logged.
 */
export function matches(matcher: string | undefined, toolName: string, log?: (message: string) => void): boolean {
	if (!matcher || matcher.trim() === "") return true;
	try {
		return new RegExp(matcher, "i").test(toolName);
	} catch {
		log?.(`hooks: invalid matcher regex ${JSON.stringify(matcher)} — treated as no-match`);
		return false;
	}
}

interface StructuredStdout {
	/** True when stdout parsed as a JSON object (even if no recognized field was set). */
	structured: boolean;
	/** Set when the JSON asked to block (decision:"block", permissionDecision:"deny", or continue:false). */
	block?: { reason?: string };
	additionalContext?: string;
	permissionDecision?: "allow" | "ask";
	systemMessage?: string;
}

/**
 * Parse a hook's stdout as Claude Code "advanced JSON output". Recognizes both the
 * legacy `{decision:"block", reason}` form and the hookSpecificOutput form
 * (`permissionDecision` deny/allow/ask + `additionalContext`). Non-JSON stdout is
 * not an error — it is plain output.
 */
function parseStructured(stdout: string): StructuredStdout {
	const trimmed = stdout.trim();
	if (!trimmed.startsWith("{")) return { structured: false };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { structured: false };
	}
	if (!parsed || typeof parsed !== "object") return { structured: false };

	const out: StructuredStdout = { structured: true };
	const top = parsed as {
		decision?: unknown;
		reason?: unknown;
		hookSpecificOutput?: unknown;
		continue?: unknown;
		stopReason?: unknown;
		systemMessage?: unknown;
	};

	const hso = top.hookSpecificOutput;
	if (hso && typeof hso === "object") {
		const h = hso as {
			permissionDecision?: unknown;
			permissionDecisionReason?: unknown;
			additionalContext?: unknown;
		};
		if (typeof h.additionalContext === "string" && h.additionalContext.length > 0) {
			out.additionalContext = h.additionalContext;
		}
		if (h.permissionDecision === "deny") {
			out.block = {
				reason: typeof h.permissionDecisionReason === "string" ? h.permissionDecisionReason : undefined,
			};
		} else if (h.permissionDecision === "allow" || h.permissionDecision === "ask") {
			out.permissionDecision = h.permissionDecision;
		}
	}
	if (top.decision === "block") {
		out.block = {
			reason: typeof top.reason === "string" ? top.reason : out.block?.reason,
		};
	}
	// continue:false is a second, independent block trigger (Claude Code's universal
	// stop signal). Only applies when nothing more specific above already blocked —
	// permissionDecision:"deny" and decision:"block" keep their own reason rather
	// than being overwritten by stopReason.
	if (top.continue === false && !out.block) {
		out.block = {
			reason: typeof top.stopReason === "string" ? top.stopReason : undefined,
		};
	}
	if (typeof top.systemMessage === "string" && top.systemMessage.length > 0) {
		out.systemMessage = top.systemMessage;
	}
	return out;
}

/**
 * Run one hook command and interpret its result. Never throws — a failure to spawn,
 * a timeout, or a kill all fail OPEN (continue, not blocked).
 */
export async function runHook(
	command: string,
	env: Record<string, string>,
	stdinJson: string,
	exec: HookExec,
	opts?: RunHookOptions,
): Promise<HookOutcome> {
	let result: ExecResult;
	try {
		result = await exec("bash", ["-c", command], {
			timeout: opts?.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
			env,
			stdin: stdinJson,
		});
	} catch (err) {
		// exec itself threw (e.g. spawn failure) — fail open.
		opts?.log?.(`hooks: exec failed for ${JSON.stringify(command)}: ${String(err)}`);
		return { blocked: false };
	}

	// A killed/timed-out hook fails OPEN (see file header).
	if (result.killed) {
		opts?.log?.(`hooks: command timed out / was killed — continuing (fail-open): ${command}`);
		return { blocked: false };
	}

	// exit 2 ⇒ block, with trimmed stderr as the reason.
	if (result.code === 2) {
		const reason = result.stderr.trim();
		return { blocked: true, reason: reason.length > 0 ? reason : undefined };
	}

	// Structured stdout ⇒ block decision and/or additionalContext, regardless of exit code.
	const structured = parseStructured(result.stdout);
	if (structured.block) {
		return {
			blocked: true,
			reason: structured.block.reason,
			additionalContext: structured.additionalContext,
			systemMessage: structured.systemMessage,
		};
	}

	// Any other non-zero exit ⇒ log and continue (NOT a block, no context injection).
	if (result.code !== 0) {
		opts?.log?.(`hooks: command exited ${result.code} (non-blocking) — continuing: ${command}`);
		return { blocked: false };
	}

	const plainStdout = structured.structured ? undefined : result.stdout.trim();
	return {
		blocked: false,
		additionalContext: structured.additionalContext,
		stdout: plainStdout && plainStdout.length > 0 ? plainStdout : undefined,
		permissionDecision: structured.permissionDecision,
		systemMessage: structured.systemMessage,
	};
}
