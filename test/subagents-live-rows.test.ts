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

	it("lists each child with its last tool call, elapsed time and tool uses, ending in a line break", () => {
		const children: LiveChild[] = [
			{
				agent: "Explore",
				startedAt: now - 14_000,
				snap: snap("Explore", [
					{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
					{ type: "toolCall", name: "bash", arguments: { command: "npm test" } },
				]),
			},
			{ agent: "code-review", startedAt: now - 75_000 },
			{
				agent: "general",
				startedAt: now,
				snap: snap("general", [
					{ type: "text", text: "Looking at it" },
					{ type: "toolCall", name: "read", arguments: { path: "/x.ts" } },
				]),
			},
		];
		expect(renderLiveRows(children, now, theme)).toBe(
			[
				"  ⎿ Explore      $ npm test · 14s · 2 tool uses",
				"  ⎿ code-review  Initializing… · 1m 15s · 0 tool uses",
				"  ⎿ general      read /x.ts · 0s · 1 tool use",
				"",
			].join("\n"),
		);
	});

	it("shows Initializing… for a child that has only written text so far", () => {
		const rows = renderLiveRows(
			[{ agent: "a", startedAt: now, snap: snap("a", [{ type: "text", text: "hi" }]) }],
			now,
			theme,
		);
		expect(rows).toBe("  ⎿ a  Initializing… · 0s · 0 tool uses\n");
	});

	it("collapses children past the third into a count that points at /tasks", () => {
		const children = ["a", "b", "c", "d", "e"].map((agent) => ({ agent, startedAt: now }));
		const rows = renderLiveRows(children, now, theme)?.split("\n") ?? [];
		expect(rows).toHaveLength(5);
		expect(rows[3]).toBe("    +2 more (/tasks)");
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
		let agent: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
		const pi = {
			registerTool: (t: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
				if (t.name === "agent") agent = t;
			},
			registerMessageRenderer: () => {},
			registerCommand: () => {},
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers[event] = handler;
			},
			sendMessage: () => {},
			getActiveTools: () => ["agent"],
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
			execute: (params: object, onUpdate?: (update: unknown) => void) =>
				agent?.execute("1", { run_in_background: false, ...params }, undefined, onUpdate, ctx),
			statuses,
			shutdown: () => handlers.session_shutdown?.({}, ctx),
		};
	}

	const running = async (opts: RunSubagentOptions): Promise<SingleResult> => {
		opts.onUpdate?.(snap(opts.def.name, [{ type: "toolCall", name: "grep", arguments: { pattern: "x" } }]));
		return { ...snap(opts.def.name, [{ type: "text", text: "done" }]), status: "ok" };
	};

	it("shows a child from its start through its progress, and clears when it ends", async () => {
		const h = harness(running);
		await h.execute({ description: "d", prompt: "go", subagent_type: "Explore" });
		expect(h.statuses[0]).toContain("Initializing…");
		expect(h.statuses[1]).toContain("grep x in .");
		expect(h.statuses.at(-1)).toBeUndefined();
	});

	it("lists a background child too, clearing once it finishes", async () => {
		let finish: (() => void) | undefined;
		const h = harness(async (opts) => {
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			return running(opts);
		});
		await h.execute({ description: "d", prompt: "go", run_in_background: true });
		expect(h.statuses.at(-1)).toContain("general-purpose");
		finish?.();
		await new Promise((r) => setTimeout(r, 0));
		expect(h.statuses.at(-1)).toBeUndefined();
		await h.shutdown();
	});

	it("keeps the caller's own progress callback working", async () => {
		const h = harness(running);
		const updates: unknown[] = [];
		await h.execute({ description: "d", prompt: "go" }, (update) => updates.push(update));
		expect(updates).toHaveLength(1);
	});

	it("shows nothing from a nested session, which has no footer", async () => {
		const h = harness(running, 1);
		await h.execute({ description: "d", prompt: "go" });
		expect(h.statuses).toEqual([]);
	});
});
