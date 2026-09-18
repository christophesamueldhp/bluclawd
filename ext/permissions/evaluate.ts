/**
 * The permission decision, as data.
 *
 * This module answers "what should happen to this tool call, and which gate decided?"
 * without performing any I/O: no prompts, no settings reads, no hook execution. The
 * extension's `tool_call` handler supplies the inputs, performs whatever I/O a verdict
 * calls for, and owns nothing else.
 *
 * WHY: the decision used to live inline in a ~330-line handler interleaved with prompting
 * and persistence, so nothing — not the user, not `/permissions`, not a test — could answer
 * "why was this call allowed?" without re-reading the whole thing. Gate order is now a
 * readable sequence, and every verdict names the gate that produced it.
 *
 * The evaluation is split in two: `evaluatePreHook` runs the gates nothing may override
 * (deny rules, protected paths), `evaluatePostHook` runs the rest (ask rules, allow
 * rules, and what the mode does with a call no rule names).
 *
 * ── The three modes, as Claude Code defines them ─────────────────────────────
 * Rules decide first in every mode: `deny` blocks, `ask` prompts, `allow` allows,
 * with precedence deny > ask > allow. Reads and read-only bash never prompt. The mode
 * only says what happens to a call NO rule names:
 *
 *   ask    every edit/write and every non-read-only command prompts
 *   edits  edit/write run; everything else prompts
 *   auto   everything runs
 *
 * `auto` is therefore the bypass mode with the rules still on: a rule set that says
 * nothing makes it approve everything, and `deny: Bash(rm -rf **)` is how a user who
 * wants a guard in auto mode gets one.
 *
 * Purity note: `isProtectedPath`/`isReadProtectedPath` do touch the filesystem (realpath, to
 * catch symlinks into protected territory), and so does `decide()` for a deny/ask path
 * rule — the same realpath widening, but for user-written rules rather than the hardcoded
 * protected set (IMPROVEMENT-PLAN.md §2.3), lazily so an allow-only rule set never pays for
 * it. That is inherent to the check, not incidental state — everything else here is a pure
 * function of its arguments. `agentDir` is INJECTED rather than read from the environment
 * so callers and tests stay in control.
 */

import type { SandboxPosture } from "../sandbox/state.ts";
import { bashWriteTargets } from "./bash-targets.ts";
import type { PermissionMode } from "./modes.ts";
import {
	bashSegments,
	type Decision,
	decide,
	exactRule,
	isProtectedPath,
	isReadProtectedPath,
	type Rules,
	searchQueries,
	subject,
	taskAgents,
} from "./rules.ts";
import { isSafeCommand } from "./safe-command.ts";

/** The gate that produced a verdict. Every verdict names exactly one. */
export type Gate =
	| "deny-rule"
	| "read-protected-path"
	| "write-protected-path"
	| "exact-allow"
	| "cli-allow"
	| "readonly-bash"
	| "allow-rule"
	| "ask-rule"
	| "read-like"
	| "accept-edits"
	| "auto-mode"
	| "sandboxed"
	| "no-matching-rule";

/** What the caller must do. `prompt` means "ask the user"; `kind` says which prompt. */
export type Outcome = "allow" | "block" | "prompt";

export interface Verdict {
	outcome: Outcome;
	gate: Gate;
	/** Shown to the model on a block, or in the prompt on a prompt. Empty when allowing. */
	reason: string;
	/** Which prompt to show, when `outcome === "prompt"`. */
	promptKind?: "protected-read" | "protected-write" | "ask";
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
	hasUI: boolean;
	/** The OS sandbox's stance, when the sandbox extension is loaded. */
	sandbox?: SandboxPosture;
}

const READ_LIKE_TOOLS = new Set(["read", "grep", "find", "ls"]);

/**
 * Tools the mode does not prompt for, though they are not reads: the three only
 * inspect, steer or stop this session's own background subagents (a steered child's
 * own tool calls still pass its gate), and `manage_agents` asks the user itself
 * before every write, in every mode — a mode prompt on top would ask twice; and
 * `contact_supervisor` is itself a question to the user; `structured_output` only hands
 * a child's result back to its parent.
 * Deny rules still apply to them.
 */
const SELF_GATED_TOOLS = new Set([
	"task_output",
	"task_stop",
	"task_message",
	"task_wait",
	"manage_agents",
	"contact_supervisor",
	"structured_output",
]);

/**
 * Will this bash command actually run inside the OS sandbox? Not when the sandbox is
 * off, when `excludedCommands` takes the command out, or when the model's
 * `dangerouslyDisableSandbox` retry is honoured. When that retry is NOT honoured
 * (`allowUnsandboxedCommands: false`) the parameter is ignored and the command still
 * runs sandboxed, exactly as Claude Code's strict sandbox mode does.
 */
function sandboxedRun(tool: string, input: Record<string, unknown>, cfg: EvalConfig): boolean {
	const sb = cfg.sandbox;
	if (!sb?.active || tool !== "bash") return false;
	if (sb.isExcluded(String(input.command ?? ""))) return false;
	return !unsandboxedRetry(tool, input, cfg);
}

/** The model asked to leave the sandbox, and the settings let it. */
function unsandboxedRetry(tool: string, input: Record<string, unknown>, cfg: EvalConfig): boolean {
	return (
		tool === "bash" &&
		input.dangerouslyDisableSandbox === true &&
		cfg.sandbox?.active === true &&
		cfg.sandbox.allowUnsandboxedCommands
	);
}

/**
 * Claude Code's ask rule for the unsandboxed retry, `Bash(dangerouslyDisableSandbox:true)`,
 * matched literally: bluclawd's rules do not match on input parameters, and this is the
 * one such rule the sandbox docs tell users to write.
 */
const RETRY_ASK_RULE = /^bash\(dangerouslyDisableSandbox:true\)$/i;

function asksAboutEveryRetry(rules: Rules): boolean {
	return (rules.ask ?? []).some((r) => RETRY_ASK_RULE.test(r));
}

/**
 * A bare `Bash` / `Bash(*)` / `Bash(**)` ask rule is skipped for a command that runs
 * sandboxed (Claude Code's auto-allow mode); content-scoped ones like `Bash(git push *)`
 * still prompt. Dropping the bare forms and re-deciding tells the two apart.
 */
const BARE_BASH_RULE = /^bash(?:\((?:\*|\*\*)?\))?$/i;

function withoutBareBashAsk(rules: Rules): Rules {
	return { ...rules, ask: (rules.ask ?? []).filter((r) => !BARE_BASH_RULE.test(r)) };
}

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
 * A `websearch` batch is decided PER QUERY the same way, so `queries` cannot carry a
 * query past a `WebSearch(...)` rule; `denyAgent`/`askAgent` then name the query.
 */
export function decideRules(
	tool: string,
	input: Record<string, unknown>,
	rules: Rules,
	cwd: string,
): { decision: Decision | null; denyAgent?: string; askAgent?: string } {
	const batch = tool === "websearch" && Array.isArray(input.queries);
	if (tool !== "task" && !batch) return { decision: decide(rules, tool, input, cwd) };

	let decision: Decision | null = null;
	let askAgent: string | undefined;
	const targets = batch ? searchQueries(input) : taskAgents(input);
	for (const target of targets) {
		const d = decide(rules, tool, batch ? { query: target } : { agent: target }, cwd);
		if (d === "deny") return { decision: "deny", denyAgent: target };
		if (d === "ask" && decision !== "ask") {
			decision = "ask";
			askAgent = target;
		} else if (d === "allow" && decision === null) {
			decision = "allow";
		}
	}
	return { decision, askAgent };
}

const ALLOW = (gate: Gate): Verdict => ({ outcome: "allow", gate, reason: "" });

/**
 * Why this configuration cannot prompt — as the clause that goes into the block reason —
 * or `undefined` when it can. Headless cannot prompt: there is no UI.
 */
function noPromptReason(cfg: EvalConfig): string | undefined {
	if (!cfg.hasUI) return "running headless (no interactive UI)";
	return undefined;
}

/** The ask prompt, or the block it becomes when nothing can show a prompt. */
function askOrBlock(gate: Gate, exact: string | null, cfg: EvalConfig, label?: string): Verdict {
	const noPrompt = noPromptReason(cfg);
	if (noPrompt) {
		return {
			outcome: "block",
			gate,
			reason: `Permission approval required, but ${noPrompt}. Blocked by default.`,
		};
	}
	return {
		outcome: "prompt",
		gate,
		promptKind: "ask",
		reason: `Permission required — ${label ? `${label}: ` : ""}${exact}`,
		exact,
	};
}

/**
 * The tool name every gate below decides on.
 *
 * `monitor` is bash with a different delivery — same `command` field, same shell — but
 * every rule verb and the protected-path screen key on the literal name "bash", so an
 * un-normalised `monitor` walked past all of them: a `deny: Bash(**)` did not match it,
 * and a write to `.bluclawd/mcp.json` was not screened. Normalising here — the one point
 * both the session's `tool_call` handler and the subagent gate go through — makes one
 * name enough for every gate, instead of a per-gate list that the next shell-carrying
 * tool would have to be added to.
 */
function governedTool(tool: string, input: Record<string, unknown>): string {
	if (tool === "monitor") return "bash";
	// Creating a schedule is judged as the task it will start, while the user is here to
	// answer; listing and cancelling touch only this session's own schedules.
	if (tool === "task_schedule") return input.action === "create" ? "task" : "task_output";
	return tool;
}

/**
 * Gates 1–3: deny rules and protected paths. No mode can override these.
 *
 * Returns `undefined` when nothing here decides and evaluation should continue in
 * {@link evaluatePostHook}.
 */
export function evaluatePreHook(rawTool: string, input: Record<string, unknown>, cfg: EvalConfig): Verdict | undefined {
	const tool = governedTool(rawTool, input);

	// 1. deny rules. (ask/allow are resolved in evaluatePostHook.)
	const { decision, denyAgent } = decideRules(tool, input, cfg.rules, cfg.cwd);
	if (decision === "deny") {
		const subj =
			(tool === "task" || tool === "websearch") && denyAgent !== undefined ? denyAgent : subject(tool, input);
		return {
			outcome: "block",
			gate: "deny-rule",
			reason: `Blocked by permission rule (deny): ${exactRule(tool, subj)}`,
		};
	}

	// 2. Protected paths, reads. Narrow by design: only files whose CONTENTS are
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

	// 3. Protected paths, writes. bash counts: `echo {} > .bluclawd/mcp.json` installs a
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
 * Gates 4–6: ask rules, allow rules, and what the mode does with an unmatched call.
 */
export function evaluatePostHook(rawTool: string, input: Record<string, unknown>, cfg: EvalConfig): Verdict {
	const tool = governedTool(rawTool, input);
	// Claude Code's sandbox auto-allow: a command that will run inside the OS sandbox is
	// approved without a prompt, in every mode. Deny rules (gate 1) and content-scoped ask
	// rules still apply; only the bare `Bash` ask rule is skipped for such a command.
	const autoAllowed = sandboxedRun(tool, input, cfg) && cfg.sandbox?.autoAllowBashIfSandboxed === true;
	const retry = unsandboxedRetry(tool, input, cfg);
	// The prompt names an unsandboxed retry as such, as Claude Code's does.
	const label = retry ? "Bash command (unsandboxed)" : undefined;
	const { decision, askAgent } = decideRules(
		tool,
		input,
		autoAllowed ? withoutBareBashAsk(cfg.rules) : cfg.rules,
		cfg.cwd,
	);
	// For `task` the subject is the agent the prompt is about: the one an ask rule named,
	// or (no rule at all) the first target — `Task()` would label the prompt with nothing
	// and persist an "Always allow" that matches nothing.
	const subj =
		tool === "task"
			? (askAgent ?? taskAgents(input)[0] ?? "")
			: tool === "websearch" && askAgent !== undefined
				? askAgent
				: subject(tool, input);
	const exact = exactRule(tool, subj);

	// 4. An ask rule matched. It prompts in EVERY mode — auto included, exactly as Claude
	//    Code's auto mode honours explicit ask rules — unless a standing grant clears it.
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
		if (tool === "bash" && !retry && isSafeCommand(subject("bash", input))) return ALLOW("readonly-bash");
		return askOrBlock("ask-rule", exact, cfg, label);
	}

	// 5. An allow rule matched. The user wrote it; it is not second-guessed.
	if (decision === "allow") return ALLOW("allow-rule");

	// 5b. Sandboxed, and the sandbox is trusted to contain it (autoAllowBashIfSandboxed).
	if (autoAllowed) return ALLOW("sandboxed");

	// 5c. An unsandboxed retry the user asked to hear about every time — even in auto.
	if (retry && asksAboutEveryRetry(cfg.rules)) return askOrBlock("ask-rule", exact, cfg, label);

	// 6. No rule matched, so the mode decides. Reads never prompt in any mode; neither
	//    does read-only bash (Claude Code auto-approves that list everywhere) — without
	//    this, `ask` would prompt for `git status`, which is the approve-without-looking
	//    training the gate must avoid.
	if (READ_LIKE_TOOLS.has(tool) || SELF_GATED_TOOLS.has(tool)) return ALLOW("read-like");
	if (decide(cfg.cliAllowRules, tool, input, cfg.cwd) === "allow") return ALLOW("cli-allow");
	// An unsandboxed retry is never "read-only": `head ~/.ssh/id_rsa` is on the safe list,
	// and the sandbox was the layer that stopped it — leaving the sandbox is exactly what
	// the user must be asked about. Found live: the retry of a denied credential read ran
	// unprompted and printed the file.
	if (tool === "bash" && !retry && isSafeCommand(String(input.command ?? ""))) return ALLOW("readonly-bash");
	if (cfg.mode === "auto") return ALLOW("auto-mode");
	if (cfg.mode === "edits" && (tool === "edit" || tool === "write")) return ALLOW("accept-edits");
	return askOrBlock("no-matching-rule", exact, cfg, label);
}
