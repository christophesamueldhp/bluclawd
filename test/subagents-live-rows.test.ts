import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STATUS_KEYS } from "../ext/_shared/status-keys.ts";
import type { RunSubagentOptions } from "../ext/subagents/engine.ts";
import { factory } from "../ext/subagents/index.ts";
import { emptyUsage, type LiveChild, renderLiveRows, type SingleResult } from "../ext/subagents/render.ts";

const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;

const snap = (agent: string, content: unknown[]): SingleResult => ({
	agent,
	agentSource: "user",
	task: "t",
	status: "running",
	messages: [{ role: "assistant", content } as never],
	stderr: "",
	usage: emptyUsage(),
});

describe("renderLiveRows", () => {
	const now = 100_000;

	it("shows nothing while no subagent runs", () => {
		expect(renderLiveRows([], now, theme)).toBeUndefined();
	});

	it("lists each child with what it does now, its elapsed time and tool count, ending in a line break", () => {
		const children: LiveChild[] = [
			{
				agent: "explore",
				startedAt: now - 14_000,
				snap: snap("explore", [
					{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
					{ type: "toolCall", name: "bash", arguments: { command: "npm test" } },
				]),
			},
			{ agent: "code-review", startedAt: now - 75_000 },
			{ agent: "general", startedAt: now, snap: snap("general", [{ type: "text", text: "Looking at it\nmore" }]) },
		];
		expect(renderLiveRows(children, now, theme)).toBe(
			[
				"  ⎿ explore      $ npm test · 14s · 2 tools",
				"  ⎿ code-review  Starting… · 1m 15s · 0 tools",
				"  ⎿ general      Looking at it · 0s · 0 tools",
				"",
			].join("\n"),
		);
	});

	it("collapses children past the third into a count", () => {
		const children = ["a", "b", "c", "d", "e"].map((agent) => ({ agent, startedAt: now }));
		const rows = renderLiveRows(children, now, theme)?.split("\n") ?? [];
		expect(rows).toHaveLength(5);
		expect(rows[3]).toBe("    +2 more (/agents)");
	});
});

describe("subagents footer status", () => {
	let agentDir: string;
	let saved: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "bluclawd-live-rows-"));
		saved = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved;
		rmSync(agentDir, { recursive: true, force: true });
	});

	function harness(run: (opts: RunSubagentOptions) => Promise<SingleResult>, depth = 0) {
		const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
		let task: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
		const pi = {
			registerTool: (t: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
				if (t.name === "task") task = t;
			},
			registerEntryRenderer: () => {},
			registerMessageRenderer: () => {},
			registerCommand: () => {},
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers[event] = handler;
			},
			appendEntry: () => {},
			sendMessage: async () => {},
			sendUserMessage: () => {},
		} as never;
		factory(pi, { run, depth });
		const statuses: (string | undefined)[] = [];
		const ctx = {
			cwd: agentDir,
			hasUI: true,
			mode: "tui",
			isProjectTrusted: () => false,
			model: undefined,
			ui: {
				theme,
				setStatus: (key: string, text: string | undefined) => key === STATUS_KEYS.subagents && statuses.push(text),
			},
		};
		handlers.session_start?.({}, ctx);
		return {
			execute: (params: unknown, onUpdate?: (update: unknown) => void) =>
				task?.execute("1", params, undefined, onUpdate, ctx),
			statuses,
		};
	}

	const running = (onRun: (opts: RunSubagentOptions) => void) => async (opts: RunSubagentOptions) => {
		onRun(opts);
		opts.onUpdate?.(snap(opts.def.name, [{ type: "toolCall", name: "grep", arguments: { pattern: "x" } }]));
		return { ...snap(opts.def.name, [{ type: "text", text: "done" }]), status: "ok" as const };
	};

	it("shows a child from its start through its progress, and clears when it ends", async () => {
		const h = harness(running(() => {}));
		await h.execute({ agent: "explore", task: "go" });
		expect(h.statuses[0]).toContain("Starting…");
		expect(h.statuses[1]).toContain("grep /x/");
		expect(h.statuses.at(-1)).toBeUndefined();
	});

	it("keeps the caller's own progress callback working", async () => {
		const h = harness(running(() => {}));
		const updates: unknown[] = [];
		await h.execute({ agent: "explore", task: "go" }, (update) => updates.push(update));
		expect(updates).toHaveLength(1);
	});

	it("shows nothing from a nested session, which has no footer", async () => {
		const h = harness(
			running(() => {}),
			1,
		);
		await h.execute({ agent: "explore", task: "go" });
		expect(h.statuses).toEqual([]);
	});
});
