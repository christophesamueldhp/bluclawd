/**
 * The permission decision, as data.
 *
 * This module answers "what should happen to this tool call, and which gate decided?"
 * without performing any I/O: no prompts, no settings reads, no hook execution. The
 * extension's `tool_call` handler supplies the inputs, performs whatever I/O a verdict
 * calls for, and owns the counters.
 *
 * WHY: the decision used to live inline in a ~330-line handler interleaved with prompting
 * and persistence, so nothing — not the user, not `/permissions`, not a test — could answer
 * "why was this call allowed?" without re-reading the whole thing. Gate order is now a
 * readable sequence, and every verdict names the gate that produced it.
 *
 * The evaluation is split in two: `evaluatePreHook` runs the gates nothing may override
 * (mode blocks, deny rules, protected paths), `evaluatePostHook` runs the rest (auto mode's
 * guardrail, `dontAsk`'s refusal, standing grants, and the prompt).
 *
 * Purity note: `isProtectedPath`/`isReadProtectedPath` do touch the filesystem (realpath, to
 * catch symlinks into protected territory), and so does `decide()` for a deny/ask path
 * rule — the same realpath widening, but for user-written rules rather than the hardcoded
 * protected set (IMPROVEMENT-PLAN.md §2.3), lazily so an allow-only rule set never pays for
 * it. That is inherent to the check, not incidental state — everything else here is a pure
 * function of its arguments. `agentDir` is INJECTED rather than read from the environment
 * so callers and tests stay in control.
 */

import { autoGuard, bashWriteTargets, dangerousCommand } from "./auto-guard.ts";
import type { PermissionMode } from "./modes.ts";
import {
	bashSegments,
	type Decision,
	decide,
	exactRule,
	isProtectedPath,
	isReadProtectedPath,
	type Rules,
	subject,
	taskAgents,
} from "./rules.ts";
import { isSafeCommand } from "./safe-command.ts";

/** The gate that produced a verdict. Every verdict names exactly one. */
export type Gate =
	| "bypass-mode"
	| "deny-rule"
	| "read-protected-path"
	| "write-protected-path"
	| "auto-guardrail"
	| "manual-guardrail"
	| "dont-ask-mode"
	| "exact-allow"
	| "cli-allow"
	| "readonly-bash"
	| "sandbox-pairing"
	| "accept-edits"
	| "ask-rule"
	| "no-matching-rule";

/** What the caller must do. `prompt` means "ask the user"; `kind` says which prompt. */
export type Outcome = "allow" | "block" | "prompt";

export interface Verdict {
	outcome: Outcome;
	gate: Gate;
	/** Shown to the model on a block, or in the prompt on a prompt. Empty when allowing. */
	reason: string;
	/** Which prompt to show, when `outcome === "prompt"`. */
	promptKind?: "protected-read" | "protected-write" | "ask" | "auto-pause";
	/** The exact `Verb(subject)` rule "Always allow" would persist, when applicable. */
	exact?: string | null;
	/** The path that tripped a protected-path gate, for the prompt text. */
	protectedPath?: string;
}

export interface EvalConfig {
	mode: PermissionMode;
	rules: Rules;
	/** `--allowedTools` grants, kept apart from `rules` (see the extension's comment). */
	cliAllowRules: Rules;
	cwd: string;
	agentDir: string;
	configDirName: string;
	sandboxActive: boolean;
	hasUI: boolean;
}

const READ_LIKE_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** Does an exact full-subject allow rule stand for this call? */
function hasExactAllow(rules: Rules, exact: string | null): boolean {
	return exact !== null && (rules.allow ?? []).includes(exact);
}

/**
 * The compound-command analogue of {@link hasExactAllow}: EVERY segment of a compound
 * bash command has its OWN exact allow rule (exactly what `persistAlwaysAllow`'s
 * per-segment writeback creates, IMPROVEMENT-PLAN.md §2.4) — not merely covered by some
 * broader glob, which would let an unrelated `Bash(**)` silently defeat an ask rule the
 * same way a bare glob already cannot for the single-command case above. Single-segment
 * commands are handled by `hasExactAllow` already; this only applies past 1 segment.
 */
function hasExactAllowForEverySegment(rules: Rules, command: string): boolean {
	const segments = bashSegments(command);
	return segments.length > 1 && segments.every((segment) => hasExactAllow(rules, exactRule("bash", segment)));
}

/**
 * The rule decision, plus (for `task`) which target agent is asking.
 *
 * `task` is decided PER TARGET AGENT across single/parallel/chain: a deny on ANY target
 * blocks the whole call, and the first asking agent becomes the prompt's subject —
 * otherwise wrapping an agent in parallel mode would walk past its `Task(...)` rule.
 */
export function decideRules(
	tool: string,
	input: Record<string, unknown>,
	rules: Rules,
	cwd: string,
): { decision: Decision | null; denyAgent?: string; askAgent?: string } {
	if (tool !== "task") return { decision: decide(rules, tool, input, cwd) };

	let decision: Decision | null = null;
	let askAgent: string | undefined;
	for (const agent of taskAgents(input)) {
		const d = decide(rules, "task", { agent }, cwd);
		if (d === "deny") return { decision: "deny", denyAgent: agent };
		if (d === "ask" && decision !== "ask") {
			decision = "ask";
			askAgent = agent;
		} else if (d === "allow" && decision === null) {
			decision = "allow";
		}
	}
	return { decision, askAgent };
}

const ALLOW = (gate: Gate): Verdict => ({ outcome: "allow", gate, reason: "" });

/**
 * `autoGuard` returns a bare noun phrase; auto mode is the one caller that refuses
 * outright, so it is the one that says so and names the way out.
 */
const autoModeReason = (reason: string): string =>
	`auto mode blocked: ${reason}. Exit auto mode (Shift+Tab) to run it.`;

/**
 * Why this configuration cannot prompt — as the clause that goes into the block reason —
 * or `undefined` when it can.
 *
 * Two independent reasons converge on the same outcome, so every prompt site asks this one
 * question. Headless cannot prompt: there is no UI. `dontAsk` refuses to by policy: Claude
 * Code's mode fallback answers "deny" in exactly the place `default` answers "ask"
 * (`if (mode === "dontAsk") return "deny"`, verified in the 2.1.220 binary), which makes the
 * mode precisely "every would-be prompt is a refusal".
 */
function noPromptReason(cfg: EvalConfig): string | undefined {
	if (cfg.mode === "dontAsk") return "dontAsk mode never prompts";
	if (!cfg.hasUI) return "running headless (no interactive UI)";
	return undefined;
}

/**
 * Gates 1–4: mode-level blocks, deny rules, and protected paths.
 *
 * Returns `undefined` when nothing here decides and evaluation should continue in
 * {@link evaluatePostHook}.
 */
export function evaluatePreHook(tool: string, input: Record<string, unknown>, cfg: EvalConfig): Verdict | undefined {
	// 1. bypass → allow everything, rules are not consulted.
	if (cfg.mode === "bypass") return ALLOW("bypass-mode");

	// 2. deny rules. (ask/allow are resolved in evaluatePostHook.)
	const { decision, denyAgent } = decideRules(tool, input, cfg.rules, cfg.cwd);
	if (decision === "deny") {
		const subj = tool === "task" && denyAgent !== undefined ? denyAgent : subject(tool, input);
		return {
			outcome: "block",
			gate: "deny-rule",
			reason: `Blocked by permission rule (deny): ${exactRule(tool, subj)}`,
		};
	}

	// 3. Protected paths, reads. Narrow by design: only files whose CONTENTS are
	//    credentials or executable config. Gating every read under .git/.bluclawd would
	//    prompt for HEAD and installed package sources, and a constantly-firing gate
	//    trains people to approve blindly.
	if (READ_LIKE_TOOLS.has(tool)) {
		const rawPath = typeof input.path === "string" ? input.path : "";
		if (rawPath && isReadProtectedPath(rawPath, cfg.cwd, cfg.agentDir, cfg.configDirName)) {
			const exact = exactRule(tool, subject(tool, input));
			if (!hasExactAllow(cfg.rules, exact)) {
				const noPrompt = noPromptReason(cfg);
				if (noPrompt) {
					return {
						outcome: "block",
						gate: "read-protected-path",
						reason: `Protected path: ${rawPath} holds agent credentials. Approval required, but ${noPrompt}. Blocked.`,
						protectedPath: rawPath,
					};
				}
				return {
					outcome: "prompt",
					gate: "read-protected-path",
					promptKind: "protected-read",
					reason: `Protected path — allow ${tool} of ${rawPath}?`,
					protectedPath: rawPath,
					exact,
				};
			}
		}
	}

	// 4. Protected paths, writes. bash counts: `echo {} > .bluclawd/mcp.json` installs a
	//    shell-executing config file exactly as `write` does (mcp.json auth headers can run
	//    shell commands via resolve-config-value.ts), so its redirect targets are screened
	//    with the same predicate. Descriptor dups (`2>&1`) carry no path and are skipped —
	//    blocking those would stop most test commands.
	if (tool === "edit" || tool === "write" || tool === "bash") {
		const candidates =
			tool === "bash"
				? bashWriteTargets(String(input.command ?? ""))
				: [typeof input.path === "string" ? input.path : ""];
		const rawPath = candidates.find(
			(candidate) => candidate && isProtectedPath(candidate, cfg.cwd, cfg.agentDir, cfg.configDirName),
		);
		if (rawPath) {
			const exact = exactRule(tool, subject(tool, input));
			if (!hasExactAllow(cfg.rules, exact)) {
				const noPrompt = noPromptReason(cfg);
				if (noPrompt) {
					return {
						outcome: "block",
						gate: "write-protected-path",
						reason: `Protected path: ${rawPath}. Approval required, but ${noPrompt}. Blocked.`,
						protectedPath: rawPath,
					};
				}
				return {
					outcome: "prompt",
					gate: "write-protected-path",
					promptKind: "protected-write",
					reason: `Protected path — allow ${tool} to ${rawPath}?`,
					protectedPath: rawPath,
					exact,
				};
			}
		}
	}

	return undefined;
}

/**
 * Gates 6–8: auto mode's guardrail, `dontAsk`'s refusal, the standing grants that clear an
 * `ask`, and finally the prompt.
 *
 * `autoBlocked` reports whether auto mode's guardrail refused, so the caller can advance its
 * counters; the caller decides whether that becomes a prompt (threshold reached) or a plain
 * block. This function reports `outcome: "block"` with `promptKind: "auto-pause"` to mean
 * "blocked, and eligible to become a pause-and-ask if your thresholds say so".
 */
export function evaluatePostHook(tool: string, input: Record<string, unknown>, cfg: EvalConfig): Verdict {
	const { decision, askAgent } = decideRules(tool, input, cfg.rules, cfg.cwd);
	const subj = tool === "task" ? (askAgent ?? "") : subject(tool, input);
	const exact = exactRule(tool, subj);

	// 6. auto mode: no prompts, but every non-trivial call is screened.
	if (cfg.mode === "auto") {
		if (hasExactAllow(cfg.rules, exact)) return ALLOW("exact-allow");
		if (decide(cfg.cliAllowRules, tool, input, cfg.cwd) === "allow") return ALLOW("cli-allow");
		if (READ_LIKE_TOOLS.has(tool)) return ALLOW("auto-guardrail");
		const verdict = autoGuard(tool, input, cfg.cwd);
		if (verdict === "allow") return ALLOW("auto-guardrail");
		return {
			outcome: "block",
			gate: "auto-guardrail",
			promptKind: "auto-pause",
			reason: autoModeReason(verdict.reason),
			exact,
		};
	}

	// 6b. dontAsk: no prompt is available, so a call is either already permitted or blocked.
	//     The grants below are gate 7's, minus `acceptEdits` (a different mode) — the question
	//     "does anything already permit this?" is identical; only the fallback differs, and
	//     here the fallback is a refusal.
	//
	//     Reads stay free. In Claude Code they resolve to "allow" before the mode fallback is
	//     ever consulted, so `dontAsk` does not deny them there either; denying them would
	//     also leave the mode unable to so much as open a file.
	//
	//     An `ask` RULE is NOT handled here — it falls through to gate 7, whose prompt
	//     `noPromptReason` turns into a block for the same reason. One prompt-to-block
	//     conversion, applied at every prompt site.
	if (cfg.mode === "dontAsk" && decision === null) {
		if (decide(cfg.cliAllowRules, tool, input, cfg.cwd) === "allow") return ALLOW("cli-allow");
		if (READ_LIKE_TOOLS.has(tool)) return ALLOW("dont-ask-mode");
		if (tool === "bash" && isSafeCommand(subject("bash", input))) return ALLOW("readonly-bash");
		// Same grant, same execution-time premise as gate 7 below — see the proof
		// comment there (IMPROVEMENT-PLAN.md §2.7).
		if (tool === "bash" && cfg.sandboxActive && autoGuard("bash", input, cfg.cwd) === "allow") {
			return ALLOW("sandbox-pairing");
		}
		// The rule that would permit this call, named so the block is actionable. `exact`
		// above cannot be reused: for `task` it is keyed to the ASKING agent, and no rule
		// matched here, so there is none. `exact` is likewise left unset on the verdict —
		// a dontAsk block never reaches the "Always allow" path that reads it.
		const denied = exactRule(tool, tool === "task" ? (taskAgents(input)[0] ?? "") : subject(tool, input)) ?? tool;
		return {
			outcome: "block",
			gate: "dont-ask-mode",
			reason: `dontAsk mode: no allow rule covers ${denied}, and this mode never prompts. Blocked.`,
		};
	}

	// 7. Standing grants that clear an `ask`.
	if (decision === "ask") {
		// An exact full-subject allow is what "Always allow" persists. Because
		// precedence is deny > ask > allow, it would otherwise be shadowed forever by
		// the very ask rule that triggered the prompt. A broad allow GLOB does not
		// match this exact check, so it cannot quietly defeat an ask rule.
		if (hasExactAllow(cfg.rules, exact)) return ALLOW("exact-allow");
		// A compound command persists one exact rule PER SEGMENT (§2.4), so the
		// single whole-line check above never matches one — without this, "Always
		// allow" on a compound would re-prompt on every subsequent identical
		// invocation, the exact training-to-approve-repeatedly failure this exists
		// to prevent. Same "exact, not a broader glob" discipline as the check above.
		if (tool === "bash" && hasExactAllowForEverySegment(cfg.rules, subj)) return ALLOW("exact-allow");
		// --allowedTools is an explicit per-invocation grant, and glob-aware.
		if (decide(cfg.cliAllowRules, tool, input, cfg.cwd) === "allow") return ALLOW("cli-allow");
		// Read-only bash is auto-approved in every mode (Claude Code's built-in list).
		if (tool === "bash" && isSafeCommand(subject("bash", input))) return ALLOW("readonly-bash");
		// With the OS sandbox active, a bash command clears the ask gate only if it
		// ALSO passes the guardrail: ordinary mutating commands run unprompted under
		// the OS cap, while what the sandbox does not actually mitigate still prompts.
		//
		// Proof this premise holds AT EXECUTION TIME, not just at grant time
		// (IMPROVEMENT-PLAN.md §2.7, investigated 2026-08-14 — no gap found):
		// `cfg.sandboxActive` is `isSandboxActive()` read fresh in the same `tool_call`
		// handler that is about to dispatch the tool (`permissions/index.ts:310`), with
		// no `await` between that read and dispatch. The bash tool does not trust a
		// value threaded through from here — it independently re-reads
		// `isSandboxActive()` at execute() time (`sandbox/index.ts:73`) to choose
		// sandboxed vs. plain operations, so a stale grant cannot silently execute
		// unsandboxed. A per-command wrap failure (`SandboxManager.wrapWithSandbox`)
		// is not caught and retried unsandboxed either — `sandbox/index.ts`'s `exec()`
		// has no catch around it, so the failure propagates as a tool error instead of
		// a silent unsandboxed run (covered by
		// `core-ext-sandbox.test.ts`: "a post-init wrap failure errors out rather than
		// silently running unsandboxed"). The only residual gap is the TOCTOU inherent
		// to any live security toggle — the user typing `/sandbox off` in the exact
		// microtask between this grant and the tool's execute() call — which requires
		// deliberate concurrent user action and degrades at most one already-approved
		// in-flight command; the model cannot trigger it. Subagent children never reach
		// this branch: `subagent-gate.ts:88` hardcodes `sandboxActive: false` for them.
		if (tool === "bash" && cfg.sandboxActive && autoGuard("bash", input, cfg.cwd) === "allow") {
			return ALLOW("sandbox-pairing");
		}
		if (cfg.mode === "acceptEdits" && (tool === "edit" || tool === "write")) return ALLOW("accept-edits");

		const noPrompt = noPromptReason(cfg);
		if (noPrompt) {
			return {
				outcome: "block",
				gate: "ask-rule",
				reason: `Permission approval required, but ${noPrompt}. Blocked by default.`,
			};
		}
		return {
			outcome: "prompt",
			gate: "ask-rule",
			promptKind: "ask",
			reason: `Permission required — ${exact}`,
			exact,
		};
	}

	// 8. An allow rule matched. An EXACT allow — the user spelled out this precise subject —
	//    is never second-guessed: a user who writes `allow: Bash(rm -rf build)` means it. A
	//    BROADER match (e.g. `allow: Bash(**)`) did not name this specific command, so it
	//    goes through the same guardrail every other allow path does — "a broad allow glob
	//    deliberately does not skip it" was FALSE for this path until this fix; resolved per
	//    IMPROVEMENT-PLAN.md §2.1 (user decision, 2026-08-14: close the skip, not the
	//    comment). Only the command denylist is applied
	//    here, not autoGuard's containment half — same scope gate 9's tail below uses for
	//    manual modes, and for the same reason (see gate 9's comment).
	if (decision === "allow") {
		if (hasExactAllow(cfg.rules, exact)) return ALLOW("exact-allow");
		const guard = tool === "bash" ? dangerousCommand(String(input.command ?? "")) : "allow";
		if (guard === "allow") return ALLOW("exact-allow");

		const noPrompt = noPromptReason(cfg);
		if (noPrompt) {
			return {
				outcome: "block",
				gate: "manual-guardrail",
				reason: `Guardrail: ${guard.reason}. Approval required, but ${noPrompt}. Blocked.`,
			};
		}
		return {
			outcome: "prompt",
			gate: "manual-guardrail",
			promptKind: "ask",
			reason: `Guardrail — ${guard.reason}. Allow ${exact}?`,
			exact,
		};
	}

	// 9. No rule matched, so nothing has decided. `default` means "the rules decide" —
	//    and a fresh install has no `permissions` key at all, so `rm -rf build` used to
	//    run unprompted in the mode whose name promises the most caution, while `auto`
	//    refused it. The mode that sounds more autonomous was the safer one
	//    (REVIEW-2026-07 §3.1b).
	//
	//    The same deterministic screen `auto` uses runs here, but its refusal becomes a
	//    PROMPT rather than a block: these modes are manual, so the user decides — and
	//    "Always allow" turns the answer into the rule that was missing.
	//
	//    Reached by `default` and `acceptEdits`, so a single Shift+Tab cannot disarm it.
	//    `bypass` returned at gate 1, `auto` at 6 and `dontAsk` at 6b.
	//
	//    Only the COMMAND denylist, deliberately — not `autoGuard`'s containment half.
	//    Screening writes and redirects for "inside the working directory" is part of auto
	//    mode's bargain (it never prompts, so it screens hard); importing it here would
	//    make every `> /tmp/log.txt` and every write to an absolute path a prompt, and
	//    since "Always allow" persists the literal path, each new file would ask again.
	//    Protected paths — `.git`, `.bluclawd`, credentials — are already gated above, in
	//    both directions, for edit/write AND bash redirect targets. Ordinary work stays
	//    silent; a gate that fires constantly only teaches people to approve without
	//    looking.
	//
	//    Read-only bash clears it, exactly as it clears the ask gate above — Claude Code
	//    auto-approves that list in every mode. Without this, the denylist's word matching
	//    turns `grep -r eval .` and `git log --grep=eval` into prompts, which is the
	//    approve-without-looking training the gate is supposed to avoid. No new exposure:
	//    `isSafeCommand` already stands as a grant at gate 7.
	const command = String(input.command ?? "");
	if (tool === "bash" && isSafeCommand(command)) return ALLOW("readonly-bash");
	const guard = tool === "bash" ? dangerousCommand(command) : "allow";
	if (guard === "allow") return ALLOW("no-matching-rule");

	const noPrompt = noPromptReason(cfg);
	if (noPrompt) {
		return {
			outcome: "block",
			gate: "manual-guardrail",
			reason: `Guardrail: ${guard.reason}. Approval required, but ${noPrompt}. Blocked.`,
		};
	}
	return {
		outcome: "prompt",
		gate: "manual-guardrail",
		promptKind: "ask",
		reason: `Guardrail — ${guard.reason}. Allow ${exact}?`,
		exact,
	};
}
