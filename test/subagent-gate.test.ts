import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import subagentPermissionGate, { createSubagentGate, type GatePrompt } from "../ext/permissions/subagent-gate.ts";

type Handler = (event: any, ctx: any) => Promise<any>;

function load(ext: InlineExtension): Handler {
	let handler: Handler | undefined;
	const factory = typeof ext === "function" ? ext : ext.factory;
	factory({
		on: (event: string, h: Handler) => {
			if (event === "tool_call") handler = h;
		},
	} as any);
	if (!handler) throw new Error("gate registered no tool_call handler");
	return handler;
}

describe("subagent permission gate", () => {
	let home: string;
	let cwd: string;
	let saved: Record<string, string | undefined>;
	const ctx = () => ({ cwd, isProjectTrusted: () => true });
	const bash = (command: string) => ({ toolName: "bash", input: { command } });

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "bluclawd-gate-home-"));
		cwd = mkdtempSync(join(tmpdir(), "bluclawd-gate-cwd-"));
		saved = { HOME: process.env.HOME };
		for (const key of Object.keys(process.env)) {
			if (key.endsWith("_CODING_AGENT_DIR")) {
				saved[key] = process.env[key];
				delete process.env[key];
			}
		}
		process.env.HOME = home;
		mkdirSync(getAgentDir(), { recursive: true });
		writeFileSync(
			join(getAgentDir(), "settings.json"),
			JSON.stringify({ permissions: { deny: ["Bash(rm **)"], ask: ["Bash(git push*)"] } }),
		);
	});
	afterEach(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	describe("default posture (no one to ask)", () => {
		it("blocks what the parent denies and runs the rest silently, ask rules included", async () => {
			const gate = load(subagentPermissionGate);
			expect((await gate(bash("rm -rf x"), ctx()))?.block).toBe(true);
			expect(await gate(bash("npm test"), ctx())).toBeUndefined();
			expect(await gate(bash("git push origin main"), ctx())).toBeUndefined();
		});
	});

	describe("with a prompt bridge to the parent's UI", () => {
		const bridged = (answer: boolean, mode: "ask" | "edits" | "auto" = "auto") => {
			const prompts: Array<{ title: string; message: string }> = [];
			const prompt: GatePrompt = async (request) => {
				prompts.push(request);
				return answer;
			};
			return { gate: load(createSubagentGate({ mode, agent: "scout", prompt })), prompts };
		};

		it("still blocks deny rules without asking", async () => {
			const { gate, prompts } = bridged(true);
			expect((await gate(bash("rm -rf x"), ctx()))?.block).toBe(true);
			expect(prompts).toEqual([]);
		});

		it("routes an ask rule to the parent, naming the subagent, and honours the answer", async () => {
			const yes = bridged(true);
			expect(await yes.gate(bash("git push origin main"), ctx())).toBeUndefined();
			expect(yes.prompts[0]?.title).toContain("scout");
			const no = bridged(false);
			const verdict = await no.gate(bash("git push origin main"), ctx());
			expect(verdict?.block).toBe(true);
			expect(verdict?.reason).toMatch(/declined/);
		});

		it("prompts for unmatched work only when the child runs in ask mode", async () => {
			const ask = bridged(true, "ask");
			expect(await ask.gate(bash("npm test"), ctx())).toBeUndefined();
			expect(ask.prompts).toHaveLength(1);
			const auto = bridged(true, "auto");
			expect(await auto.gate(bash("npm test"), ctx())).toBeUndefined();
			expect(auto.prompts).toHaveLength(0);
		});

		it("asks before a protected-path write instead of refusing outright", async () => {
			const { gate, prompts } = bridged(true);
			const write = { toolName: "write", input: { path: join(cwd, ".git", "hooks", "pre-commit"), content: "x" } };
			expect(await gate(write, ctx())).toBeUndefined();
			expect(prompts).toHaveLength(1);
		});
	});

	describe("rules anchored to the parent's working tree", () => {
		it("applies the parent's project deny rule to a child whose cwd is a worktree", async () => {
			const parent = mkdtempSync(join(tmpdir(), "bluclawd-gate-parent-"));
			mkdirSync(join(parent, ".pi"), { recursive: true });
			mkdirSync(join(parent, CONFIG_DIR_NAME), { recursive: true });
			writeFileSync(
				join(parent, CONFIG_DIR_NAME, "settings.json"),
				JSON.stringify({ permissions: { deny: ["Bash(curl **)"] } }),
			);
			const gate = load(createSubagentGate({ mode: "auto", rulesCwd: parent }));
			const childCtx = { cwd, isProjectTrusted: () => true };
			expect((await gate(bash("curl http://x"), childCtx))?.block).toBe(true);
			rmSync(parent, { recursive: true, force: true });
		});
	});
});
