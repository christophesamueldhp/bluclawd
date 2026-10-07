import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setSharedTheme } from "../ext/_shared/theme.ts";
import { AgentView, type PaneOps } from "../ext/agent-view/agent-view.ts";
import type { OrchestratorClient } from "../ext/agent-view/orchestrator-client.ts";
import { rowFromShell } from "../ext/agent-view/rows.ts";
import { type ShellInfo, Tmux } from "../ext/agent-view/tmux.ts";

const plainTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	getBgAnsi: () => "",
	getColorMode: () => "truecolor",
} as unknown as Theme;
const HERE = "/home/me/proj";
const ENTER = "\r";
const CTRL_X = "\x18";

beforeAll(() => setSharedTheme(plainTheme));

const shell = (extra: Partial<ShellInfo> = {}): ShellInfo => ({
	name: "sh-1",
	command: "npm test",
	cwd: HERE,
	createdAt: new Date().toISOString(),
	stopped: false,
	...extra,
});

describe("a ! command's row, as Claude Code's", () => {
	it("works while it runs, its last output line the detail; then done, failed with its exit, or stopped", () => {
		expect(rowFromShell(shell({ lastLine: "✓ 12 passed" }))).toMatchObject({
			id: "sh-1",
			shell: "sh-1",
			label: "!npm test",
			state: "working",
			alive: true,
			detail: "✓ 12 passed",
		});
		expect(rowFromShell(shell({ exit: "0", lastLine: "done" }))).toMatchObject({
			state: "done",
			alive: false,
			detail: "done",
		});
		expect(rowFromShell(shell({ exit: "0" }))).toMatchObject({ detail: "(no output)" });
		expect(rowFromShell(shell({ exit: "1", lastLine: "2 failed" }))).toMatchObject({
			state: "failed",
			detail: "exit 1 — 2 failed",
		});
		expect(rowFromShell(shell({ exit: "143", stopped: true }))).toMatchObject({
			state: "stopped",
			detail: "stopped",
		});
	});
});

function setup(shells: ShellInfo[]) {
	const calls: unknown[][] = [];
	const client = {
		list: async () => [],
		ensureDaemon: async () => true,
		getDaemonInfo: async () => ({ running: false }),
		delete: async (id: string) => {
			calls.push(["delete", id]);
		},
	} as unknown as OrchestratorClient;
	const panes: PaneOps = {
		current: "pi-self",
		switchTo: () => {},
		start: () => "pi-new",
		waitForView: async () => {},
		end: () => {},
		kill: (name) => calls.push(["kill", name]),
		unlist: async () => {},
		detach: () => {},
		startShell: (cwd, command) => {
			calls.push(["startShell", cwd, command]);
			return "sh-new";
		},
		listShells: () => shells,
		stopShell: (name) => calls.push(["stopShell", name]),
		capture: () => ["$ npm test", "", "✓ 12 passed"],
	};
	const view = new AgentView({
		ui: { terminal: { rows: 40 }, requestRender: () => {} } as unknown as TUI,
		client,
		appName: "bluclawd",
		cwd: HERE,
		home: "/home/me",
		onClose: () => {},
		panes,
	});
	const flush = async () => {
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
	};
	const text = () =>
		view
			.render(120)
			.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
			.join("\n");
	return { view, calls, flush, text };
}

describe("! in agent view's composer", () => {
	it("!command + enter runs it in the user's shell, in a session of its own", async () => {
		const { view, calls, flush } = setup([]);
		await view.onShow();
		for (const ch of "!npm test") view.handleInput(ch);
		view.handleInput(ENTER);
		await flush();
		expect(calls).toEqual([["startShell", HERE, "npm test"]]);
	});

	it("lists running and finished commands; enter shows the output, which takes no reply", async () => {
		const { view, text, flush } = setup([shell({ lastLine: "running suite" })]);
		await view.onShow();
		await flush();
		expect(text()).toMatch(/Working\n.*!npm test\s+running suite/);
		view.handleInput(ENTER);
		await flush();
		expect(text()).toContain("✓ 12 passed");
		for (const ch of "hello") view.handleInput(ch);
		view.handleInput(ENTER);
		await flush();
		expect(text()).toContain("a shell command takes no reply");
	});

	it("ctrl+x stops a running command and keeps its row; a second press removes it", async () => {
		const { view, calls, flush } = setup([shell()]);
		await view.onShow();
		await flush();
		view.handleInput(CTRL_X);
		await flush();
		expect(calls).toEqual([["stopShell", "sh-1"]]);
		view.handleInput(CTRL_X);
		await flush();
		expect(calls.slice(1)).toEqual([["kill", "sh-1"]]);
	});
});

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;

describe.skipIf(!hasTmux)("tmux runs a ! command", () => {
	let tmux: Tmux | undefined;
	afterEach(() => {
		if (tmux) spawnSync("tmux", ["-S", tmux.socket, "kill-server"]);
	});

	it("records its exit status and keeps its output; stopping marks it stopped", async () => {
		tmux = new Tmux(mkdtempSync(join(tmpdir(), "bc-shell-")));
		const ok = tmux.startShell(tmpdir(), "echo first; echo last-line");
		const bad = tmux.startShell(tmpdir(), "echo oops; exit 3");
		const slow = tmux.startShell(tmpdir(), "sleep 30");
		await vi.waitFor(
			() => {
				const shells = tmux?.listShells() ?? [];
				expect(shells.find((s) => s.name === ok)).toMatchObject({
					exit: "0",
					lastLine: "last-line",
					command: "echo first; echo last-line",
				});
				expect(shells.find((s) => s.name === bad)).toMatchObject({ exit: "3", lastLine: "oops" });
				expect(shells.find((s) => s.name === slow)).toMatchObject({ exit: undefined, stopped: false });
			},
			{ timeout: 5000 },
		);
		tmux.stopShell(slow);
		await vi.waitFor(
			() =>
				expect(tmux?.listShells().find((s) => s.name === slow)).toMatchObject({
					stopped: true,
					exit: expect.any(String),
				}),
			{ timeout: 5000 },
		);
		expect(tmux.capture(ok, 10)).toEqual(["first", "last-line"]);
	});
});
