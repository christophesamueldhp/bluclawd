import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tmux } from "../daemon/tmux.ts";
import agentView from "../ext/agent-view/index.ts";
import { launchInTmux } from "../ext/agent-view/launch.ts";
import { bluclawdExtensions } from "../ext/index.ts";
import tmuxLaunch from "../ext/tmux-launch/index.ts";

// The real one attaches tmux and exits the process.
vi.mock("../ext/agent-view/launch.ts", () => ({ launchInTmux: vi.fn(() => true) }));

/** A PATH holding only a `tmux` that answers `-V` and records every call in `calls`, or nothing at all. */
function pathWith(tmux: boolean): string {
	const dir = mkdtempSync(join(tmpdir(), "bluclawd-path-"));
	if (tmux) {
		writeFileSync(join(dir, "tmux"), `#!/bin/sh\necho "$*" >> '${join(dir, "calls")}'\necho 'tmux 3.5'\n`);
		chmodSync(join(dir, "tmux"), 0o755);
	}
	return dir;
}

type Handler = (event: unknown, ctx: unknown) => unknown;

function load(factory: (pi: never) => void): Record<string, Handler> {
	const handlers: Record<string, Handler> = {};
	factory({
		on: (event: string, handler: Handler) => {
			handlers[event] = handler;
		},
		registerCommand: () => {},
		registerShortcut: () => {},
		events: { on: () => () => {}, emit: () => {} },
	} as never);
	return handlers;
}

function tuiCtx(mode = "tui") {
	const notes: string[] = [];
	const ctx = {
		mode,
		cwd: "/p",
		ui: {
			theme: { fg: (_c: string, t: string) => t, getColorMode: () => "256" },
			notify: (text: string) => notes.push(text),
			setStatus: () => {},
		},
	};
	return { ctx, notes };
}

beforeEach(() => {
	vi.mocked(launchInTmux).mockClear();
	vi.stubEnv("BLUCLAWD_PANE", "");
	vi.stubEnv("PATH", pathWith(true));
});
afterEach(() => vi.unstubAllEnvs());

describe("launching into tmux before the other extensions start", () => {
	it("comes first, ahead of permissions, sandbox and the rest in their order, agent view still 8th among them", () => {
		expect(bluclawdExtensions().map((e) => e.name)).toEqual([
			"tmux-launch",
			"permissions",
			"sandbox",
			"checkpoints",
			"background-bash",
			"subagents",
			"branding",
			"transcript",
			"agent-view",
			"remote",
			"help",
			"vibes",
			"paste",
			"skills",
			"prompt-assist",
			"web",
			"memory",
			"accounts",
		]);
	});

	it("a TUI pi outside a pane, with tmux, launches its session into tmux, once", async () => {
		const handlers = load(tmuxLaunch);
		const { ctx, notes } = tuiCtx();
		await handlers.session_start({ reason: "startup" }, ctx);
		await handlers.session_start({ reason: "reload" }, ctx);
		expect(vi.mocked(launchInTmux).mock.calls.map(([c]) => c)).toEqual([ctx]);
		expect(notes).toEqual([]);
	});

	it("launches nothing in a pane, outside the TUI, or without tmux, and leaves the warning to agent view", async () => {
		const handlers = () => load(tmuxLaunch);
		vi.stubEnv("BLUCLAWD_PANE", "pi-1234abcd");
		await handlers().session_start({}, tuiCtx().ctx);
		vi.stubEnv("BLUCLAWD_PANE", "");
		for (const mode of ["rpc", "json", "print"]) await handlers().session_start({}, tuiCtx(mode).ctx);
		vi.stubEnv("PATH", pathWith(false));
		const { ctx, notes } = tuiCtx();
		await handlers().session_start({}, ctx);
		expect(launchInTmux).not.toHaveBeenCalled();
		expect(notes).toEqual([]);
	});

	it("agent view, outside a pane with tmux, neither launches again nor warns", async () => {
		const path = pathWith(true);
		vi.stubEnv("PATH", path);
		const handlers = load(agentView);
		const { ctx, notes } = tuiCtx();
		await handlers.session_start({}, ctx);
		expect(readFileSync(join(path, "calls"), "utf8").trim().split("\n")).toEqual(["-V"]);
		expect(notes).toEqual([]);
	});

	it("a tmux that cannot start the pane says why once, and the terminal's pi goes on", async () => {
		const { launchInTmux: realLaunch } =
			await vi.importActual<typeof import("../ext/agent-view/launch.ts")>("../ext/agent-view/launch.ts");
		const { ctx, notes } = tuiCtx();
		const failing = new Tmux("/nonexistent", () => {
			throw new Error("no server running");
		});
		expect(realLaunch({ ...ctx, sessionManager: { getSessionFile: () => undefined } } as never, failing)).toBe(false);
		expect(notes).toEqual(["Agent view is off — tmux couldn't start: no server running"]);
	});
});
