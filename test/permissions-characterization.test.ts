/**
 * Characterization test for the permission decision path.
 *
 * Pins what `evaluatePreHook`/`evaluatePostHook` currently decide across a
 * mode × rules × tool cross-product, so a refactor can be proven equivalent
 * rather than hoped equivalent — same technique as the bluclawd fork branch's
 * `core-ext-permissions-characterization.test.ts`, which this is adapted from.
 *
 * Adapted, not ported verbatim: the fork's version drove the decision through
 * a full `ExtensionRunner` + event bus + `loadExtensionFromFactory` harness,
 * exercising the registered `tool_call` handler end to end. That harness's
 * `loadExtensionFromFactory` is no longer part of pi's public surface (renamed
 * or removed upstream since the fork was written) or exported from
 * `bluclawd/ext/permissions/index.ts`. This calls `evaluatePreHook`/
 * `evaluatePostHook` directly instead — the pure decision functions the
 * handler wraps — which covers the same gate logic without the wiring layer.
 * `registration.test.ts` covers that the extension registers and wires events
 * at all; this covers what it decides once wired.
 *
 * Deliberately excluded, same as the original: the "Always allow" settings
 * writeback — it needs I/O this table cannot hold still for.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluatePostHook, evaluatePreHook } from "../ext/permissions/evaluate.ts";
import type { PermissionMode } from "../ext/permissions/modes.ts";
import type { Rules } from "../ext/permissions/rules.ts";

const RULE_SETS: Record<string, Rules> = {
	none: {},
	"deny-bash": { deny: ["Bash(**)"] },
	"ask-all": { ask: ["Bash(**)", "Read(**)", "Write(**)", "Edit(**)", "Task(**)", "Mcp(**)"] },
	"allow-glob": { ask: ["Bash(**)"], allow: ["Bash(npm *)"] },
	"allow-exact": { ask: ["Bash(**)"], allow: ["Bash(npm install)"] },
	// A broad, un-narrowed allow glob reaching a dangerous command with no `ask` rule to
	// clear first — `allow-glob`/`allow-exact` never exercise this: both pair their allow
	// with `ask: Bash(**)`, so a non-matching call falls into the ask gate, not this one.
	"allow-all-bash": { allow: ["Bash(**)"] },
};

const MODES: readonly PermissionMode[] = ["default", "acceptEdits", "auto", "bypass", "dontAsk"];

function toolCases(
	cwd: string,
	agentDir: string,
): Array<{ name: string; tool: string; input: Record<string, unknown> }> {
	return [
		{ name: "bash-safe", tool: "bash", input: { command: "git status" } },
		{ name: "bash-mutating", tool: "bash", input: { command: "npm install" } },
		{ name: "bash-dangerous", tool: "bash", input: { command: "rm -rf build" } },
		{ name: "read-normal", tool: "read", input: { path: join(cwd, "src", "x.ts") } },
		{ name: "read-credential", tool: "read", input: { path: join(agentDir, "auth.json") } },
		{ name: "write-normal", tool: "write", input: { path: join(cwd, "src", "x.ts") } },
		{ name: "write-git-hook", tool: "write", input: { path: join(cwd, ".git", "hooks", "pre-commit") } },
		{ name: "edit-normal", tool: "edit", input: { path: join(cwd, "src", "x.ts") } },
		{ name: "write-outside-cwd", tool: "write", input: { path: "/etc/hosts" } },
		{ name: "task-explore", tool: "task", input: { agent: "explore" } },
		{ name: "mcp-tool", tool: "mcp__srv__do", input: {} },
	];
}

/** One row's observable outcome, collapsed to a single stable line. */
function encode(key: string, cwd: string, agentDir: string, verdict: ReturnType<typeof evaluatePostHook>): string {
	const reason = verdict.reason.replaceAll(agentDir, "<AGENT>").replaceAll(cwd, "<CWD>").replace(/\s+/g, " ").trim();
	return `${key} => ${verdict.outcome.toUpperCase()}${verdict.gate ? ` [${verdict.gate}]` : ""}${reason ? ` :: ${reason}` : ""}`;
}

describe("permissions decision characterization (pin current behaviour)", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "bluclawd-perm-char-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(join(cwd, "src"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("matches the recorded decision table", () => {
		const lines: string[] = [];

		for (const sandboxActive of [false, true]) {
			for (const hasUI of [true, false]) {
				for (const [rulesName, rules] of Object.entries(RULE_SETS)) {
					for (const mode of MODES) {
						for (const { name, tool, input } of toolCases(cwd, agentDir)) {
							const cfg = {
								mode,
								rules,
								cliAllowRules: {},
								cwd,
								agentDir,
								configDirName: ".bluclawd",
								sandboxActive,
								hasUI,
							};
							const pre = evaluatePreHook(tool, input, cfg);
							const verdict = pre ?? evaluatePostHook(tool, input, cfg);
							const key = `sandbox=${sandboxActive} ui=${hasUI} rules=${rulesName} mode=${mode} case=${name}`;
							lines.push(encode(key, cwd, agentDir, verdict));
						}
					}
				}
			}
		}

		if (process.env.PERMISSIONS_CHARACTERIZATION_PRINT === "1") {
			console.log(lines.join("\n"));
		}

		expect(lines).toMatchFileSnapshot("./__snapshots__/permissions-characterization.table.txt");
	});
});
