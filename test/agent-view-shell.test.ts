import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { OrchestratorClient } from "../daemon/orchestrator-client.ts";
import { rowFromShell } from "../daemon/rows.ts";
import { type ShellInfo, Tmux } from "../daemon/tmux.ts";
import { setSharedTheme } from "../ext/_shared/theme.ts";
import { AgentView, type PaneOps } from "../ext/agent-view/agent-view.ts";
import { waitFor } from "./helpers/wait-for.ts";

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

describe("a ! command's row, as bluclawd's", () => {
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
	/** Every tmux read the view made, and the output its captures return. */
	const tmux = {
		reads: 0,
		output: ["$ npm test", "", "✓ 12 passed"],
		outputOf: {} as Record<string, string[]>,
		gates: {} as Record<string, Promise<void>>,
	};
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
		listShells: () => {
			tmux.reads++;
			return shells;
		},
		listShellsAsync: async () => {
			tmux.reads++;
			return shells;
		},
		stopShell: (name) => calls.push(["stopShell", name]),
		captureAsync: async (name) => {
			tmux.reads++;
			await tmux.gates[name];
			return tmux.outputOf[name] ?? tmux.output;
		},
	};
	const view = new AgentView({
		ui: { terminal: { rows: 40 }, requestRender: () => {} } as unknown as TUI,
		client,
		appName: "bluclawd",
		cwd: HERE,
		home: "/home/me",
		externalEditor: () => "true",
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
	return { view, calls, flush, text, tmux };
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

	it("a peek at a command reads no tmux while it draws; each refresh brings its newer output", async () => {
		const { view, text, flush, tmux } = setup([shell()]);
		await view.onShow();
		await flush();
		view.handleInput(" ");
		await flush();
		expect(text()).toContain("✓ 12 passed");
		const reads = tmux.reads;
		for (let i = 0; i < 10; i++) text();
		expect(tmux.reads).toBe(reads);
		tmux.output = ["$ npm test", "", "✓ 13 passed"];
		await waitFor(() => expect(text()).toContain("✓ 13 passed"));
		view.close();
	});

	it("↓ in a peek moves it to the next command, whose output shows at once", async () => {
		const { view, text, flush, tmux } = setup([
			shell({ createdAt: "2026-01-01T00:00:02.000Z" }),
			shell({ name: "sh-2", command: "ls", createdAt: "2026-01-01T00:00:01.000Z" }),
		]);
		tmux.outputOf["sh-2"] = ["$ ls", "file-b"];
		await view.onShow();
		await flush();
		view.handleInput(" ");
		await flush();
		expect(text()).toContain("✓ 12 passed");
		view.handleInput("\x1b[B");
		await flush();
		expect(text()).toContain("file-b");
		expect(text()).not.toContain("✓ 12 passed");
		view.close();
	});

	it("a peek moved on before the last command's output came keeps the new command's", async () => {
		const { view, text, flush, tmux } = setup([
			shell({ createdAt: "2026-01-01T00:00:02.000Z" }),
			shell({ name: "sh-2", command: "ls", createdAt: "2026-01-01T00:00:01.000Z" }),
		]);
		tmux.outputOf["sh-2"] = ["$ ls", "file-b"];
		let land = () => {};
		tmux.gates["sh-1"] = new Promise((resolve) => {
			land = resolve;
		});
		await view.onShow();
		await flush();
		view.handleInput(" ");
		view.handleInput("\x1b[B");
		await flush();
		expect(text()).toContain("file-b");
		land();
		await flush();
		expect(text()).toContain("file-b");
		view.close();
	});

	it("? leaves shift+↑↓ out of the grid, as a command keeps no order", async () => {
		const { view, text, flush } = setup([shell()]);
		await view.onShow();
		await flush();
		view.handleInput("?");
		expect(text()).toContain("? to close");
		expect(text()).not.toContain("shift+↑↓");
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
	const children: number[] = [];
	afterEach(() => {
		for (const pid of children.splice(0)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
		if (tmux) spawnSync("tmux", ["-S", tmux.socket, "kill-server"]);
	});

	it("stops nested command descendants, including ones ignoring TERM, without ending the wrapper", async () => {
		tmux = new Tmux(mkdtempSync(join(tmpdir(), "bc-shell-tree-")));
		const name = tmux.startShell(tmpdir(), "/bin/sh -c 'trap \"\" TERM; sleep 30 & echo child=$!; wait'");
		const other = tmux.startShell(tmpdir(), "sleep 30");
		let pid = 0;
		await waitFor(() => {
			pid = Number(/child=(\d+)/.exec(tmux?.capture(name, 20).join("\n") ?? "")?.[1]);
			expect(pid).toBeGreaterThan(1);
		});
		children.push(pid);

		tmux.stopShell(name);

		await waitFor(() => {
			const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
			expect(state === "" || state.startsWith("Z")).toBe(true);
			expect(tmux?.listShells().find((s) => s.name === name)).toMatchObject({
				stopped: true,
				exit: expect.any(String),
			});
		});
		expect(tmux.listShells().find((s) => s.name === other)).toMatchObject({ stopped: false, exit: undefined });
	});

	it("records its exit status and keeps its output; stopping marks it stopped", async () => {
		tmux = new Tmux(mkdtempSync(join(tmpdir(), "bc-shell-")));
		const ok = tmux.startShell(tmpdir(), "echo first; echo last-line");
		const bad = tmux.startShell(tmpdir(), "echo oops; exit 3");
		const slow = tmux.startShell(tmpdir(), "sleep 30");
		await waitFor(() => {
			const shells = tmux?.listShells() ?? [];
			expect(shells.find((s) => s.name === ok)).toMatchObject({
				exit: "0",
				lastLine: "last-line",
				command: "echo first; echo last-line",
			});
			expect(shells.find((s) => s.name === bad)).toMatchObject({ exit: "3", lastLine: "oops" });
			expect(shells.find((s) => s.name === slow)).toMatchObject({ exit: undefined, stopped: false });
		});
		tmux.stopShell(slow);
		await waitFor(() =>
			expect(tmux?.listShells().find((s) => s.name === slow)).toMatchObject({
				stopped: true,
				exit: expect.any(String),
			}),
		);
		expect(tmux.capture(ok, 10)).toEqual(["first", "last-line"]);
	});

	it("lists commands and reads output without blocking, as the sync calls do", async () => {
		tmux = new Tmux(mkdtempSync(join(tmpdir(), "bc-shell-async-")));
		expect(await tmux.listShellsAsync()).toEqual([]);
		const ok = tmux.startShell(tmpdir(), "echo first; echo last-line");
		const bad = tmux.startShell(tmpdir(), "echo oops; exit 3");
		await waitFor(() => expect(tmux?.listShells().find((s) => s.name === bad)?.exit).toBe("3"));
		const shells = await tmux.listShellsAsync();
		expect(shells.find((s) => s.name === ok)).toMatchObject({ exit: "0", lastLine: "last-line" });
		expect(shells).toEqual(tmux.listShells());
		expect(await tmux.captureAsync(ok, 10)).toEqual(["first", "last-line"]);
		await expect(tmux.captureAsync("sh-gone", 10)).rejects.toThrow();
	});

	it("says whether a session is there without blocking, as hasSession does", async () => {
		tmux = new Tmux(mkdtempSync(join(tmpdir(), "bc-has-async-")));
		// No server yet: every session is gone.
		expect(await tmux.hasSessionAsync("sh-none")).toBe(false);
		const name = tmux.startShell(tmpdir(), "sleep 30");
		expect(await tmux.hasSessionAsync(name)).toBe(true);
		expect(await tmux.hasSessionAsync("sh-gone")).toBe(false);
		expect(tmux.hasSession("sh-gone")).toBe(false);
	});
});
