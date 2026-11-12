import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUN_PANE_ENV } from "../daemon/tmux.ts";
import paneChild from "../ext/subagents/pane-child.ts";
import { prepareRpcHost, readPaneChildState } from "../ext/subagents/rpc-host.ts";

describe("a run's pi in a pane, waiting on a dialog", () => {
	let runDir: string;
	let handlers: Map<string, (event: unknown) => unknown>;
	const prompt = (type: "ui_prompt_start" | "ui_prompt_end", kind: string) =>
		handlers.get(type)?.({ type, reason: "ui_prompt", kind });
	const awaiting = () => readPaneChildState(runDir)?.awaiting;

	beforeEach(() => {
		runDir = mkdtempSync(join(tmpdir(), "bc-pane-child-"));
		prepareRpcHost(runDir, {
			args: [],
			cwd: runDir,
			agentDir: runDir,
			prompt: "Look.",
			model: { provider: "faux", id: "faux-1", thinkingLevel: "off" },
			generation: 0,
			pane: { session: "sub_run-0", parent: "pi-orchestrator" },
		});
		vi.stubEnv(RUN_PANE_ENV, runDir);
		vi.stubEnv("TMUX", "");
		handlers = new Map();
		paneChild({ on: (event: string, handler: (event: unknown) => unknown) => handlers.set(event, handler) } as never);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(runDir, { recursive: true, force: true });
	});

	it("says it needs input while a blocking dialog is open, an approval or one the user opened", () => {
		for (const kind of ["select", "confirm", "input", "editor"]) {
			prompt("ui_prompt_start", kind);
			expect(awaiting()).toBe(true);
			prompt("ui_prompt_end", kind);
			expect(awaiting()).toBe(false);
		}
	});

	it("does not for a custom UI, nor stops saying so when one closes over an open approval", () => {
		prompt("ui_prompt_start", "custom");
		expect(awaiting()).not.toBe(true);
		prompt("ui_prompt_end", "custom");

		prompt("ui_prompt_start", "select");
		prompt("ui_prompt_start", "custom");
		prompt("ui_prompt_end", "custom");
		expect(awaiting()).toBe(true);
	});
});
