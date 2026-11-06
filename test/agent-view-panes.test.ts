import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { listSummaries } from "../daemon/handler.ts";
import type { ResumeSpec, StartSpec } from "../daemon/ipc/protocol.ts";
import type { InstanceSummary, OrchestratorClient } from "../daemon/orchestrator-client.ts";
import { type AgentRow, collectRows, otherRows, rowFromShell } from "../daemon/rows.ts";
import { HIDE_ENV, OPEN_VIEW_ENV, PANE_ENV, Tmux } from "../daemon/tmux.ts";
import { setSharedTheme } from "../ext/_shared/theme.ts";
import { AgentView, type PaneOps } from "../ext/agent-view/agent-view.ts";
import {
	isBlankPane,
	leaveViewAction,
	paneArgs,
	promptContent,
	promptOptions,
	shutdownPlan,
} from "../ext/agent-view/index.ts";
import { bandTargets, deletable, RowActions, type RowClient } from "../ext/agent-view/row-actions.ts";
import { SelfRegistration } from "../ext/agent-view/self-registration.ts";
import { focusedLine } from "./helpers/agent-view-focus.ts";
import { testRegistry } from "./helpers/registry.ts";
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

type Calls = unknown[][];

/** The fake daemon client and tmux, every call recorded in order into one list. */
function recorder(overrides: Partial<RowClient> = {}) {
	const calls: Calls = [];
	const record =
		(name: string) =>
		async (...args: unknown[]) => {
			calls.push([name, ...args]);
		};
	const client: RowClient = {
		send: record("send"),
		delete: record("delete"),
		setMeta: record("setMeta"),
		start: async (spec: StartSpec) => {
			calls.push(["claim", spec]);
			return "pane" in spec ? spec.pane : "claimed";
		},
		startFailed: record("startFailed"),
		...overrides,
	};
	let started = 0;
	const panes: PaneOps = {
		current: "pi-self",
		switchTo: (name) => calls.push(["switchTo", name]),
		start: (cwd, args, env) => {
			calls.push(["start", cwd, args, env]);
			return `pi-new${++started}`;
		},
		waitForView: async (name) => {
			calls.push(["waitForView", name]);
		},
		end: (name) => calls.push(["end", name]),
		kill: (name) => calls.push(["kill", name]),
		unlist: async () => {
			calls.push(["unlist"]);
		},
		detach: () => calls.push(["detach"]),
		startShell: () => "sh-new",
		listShells: () => [],
		listShellsAsync: async () => [],
		stopShell: (name) => calls.push(["stopShell", name]),
		captureAsync: async () => [],
	};
	return { calls, client, panes };
}

function setup(instances: InstanceSummary[], self?: InstanceSummary, overrides: Partial<OrchestratorClient> = {}) {
	const { calls, client, panes } = recorder();
	let closed = 0;
	const view = new AgentView({
		ui: { terminal: { rows: 40 }, requestRender: () => {} } as unknown as TUI,
		client: {
			list: async () => instances,
			ensureDaemon: async () => true,
			getDaemonInfo: async () => ({ running: false }),
			...client,
			...overrides,
		} as unknown as OrchestratorClient,
		appName: "bluclawd",
		cwd: HERE,
		home: "/home/me",
		self: () => self,
		onClose: () => closed++,
		panes,
		instances,
	});
	const flush = async () => {
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
	};
	return { view, calls, closed: () => closed, flush, panes };
}

/** A failed tmux command, as execFileSync throws it: the command line in the message, tmux's words in stderr. */
const tmuxFailure = (stderr: string) =>
	Object.assign(
		new Error(`Command failed: tmux -S /srv/tmux.sock -f /srv/tmux.conf switch-client -t =pi-a\n${stderr}`),
		{
			stderr,
		},
	);

const paneRow = (id: string, extra: Partial<InstanceSummary> = {}): InstanceSummary => ({
	id,
	status: "online",
	cwd: HERE,
	external: true,
	pane: id,
	sessionFile: `/s/${id}.jsonl`,
	activity: "working",
	createdAt: new Date().toISOString(),
	...extra,
});

/** Row actions over the recorder, and its calls. */
function actions(overrides: Partial<RowClient> = {}) {
	const rec = recorder(overrides);
	let stoppedSelf = 0;
	const rowActions = new RowActions({
		client: rec.client,
		panes: rec.panes,
		cwd: HERE,
		onStopSelf: () => stoppedSelf++,
	});
	return { ...rec, actions: rowActions, stoppedSelf: () => stoppedSelf };
}

/** A listed session as agent view shows it. */
const rowOf = (inst: InstanceSummary, self?: InstanceSummary): AgentRow => {
	const row = collectRows([inst], self).find((r) => r.id === inst.id);
	if (!row) throw new Error(`no row for ${inst.id}`);
	return row;
};

const storedRow = (id: string, extra: Partial<InstanceSummary> = {}): AgentRow =>
	rowOf({ id, status: "stopped", cwd: HERE, sessionFile: `/s/${id}.jsonl`, outcome: "done", ...extra });

const notCancelled = () => false;

/** The view's side of a hand-off, its steps recorded among the calls when given them. */
const handOff = (calls?: Calls) => ({
	leaving: () => calls?.push(["leaving"]),
	left: () => calls?.push(["left"]),
});

describe("row actions: open", () => {
	it("switches to a pane at once, waiting on nothing", async () => {
		const { actions: a, calls } = actions();
		const opening = a.open(rowOf(paneRow("pi-a")), notCancelled);
		expect(calls).toEqual([["switchTo", "pi-a"]]);
		expect(await opening).toEqual({ kind: "left" });
	});

	it("gives a stored session a pane of its own, claimed first, then switches to it", async () => {
		const { actions: a, calls } = actions();
		expect(await a.open(storedRow("s"), notCancelled)).toEqual({ kind: "left" });
		// Claimed first, so a phone's resume of the same file is refused; the stored row stays as its row.
		expect(calls).toEqual([
			["claim", { cwd: HERE, sessionFile: "/s/s.jsonl" }],
			["start", HERE, ["--session", "/s/s.jsonl"], undefined],
			["switchTo", "pi-new1"],
		]);
	});

	it("claim refused, so no spawn, and it says why", async () => {
		const { actions: a, calls } = actions({
			start: async () => {
				throw new Error("it is already starting — try again in a moment");
			},
		});
		expect(await a.open(storedRow("s"), notCancelled)).toEqual({
			kind: "failed",
			text: "Couldn't open — it is already starting — try again in a moment",
		});
		expect(calls).toEqual([]);
	});

	it("a pane that cannot be started gives its claim back", async () => {
		const { actions: a, calls, panes } = actions();
		panes.start = () => {
			throw tmuxFailure("no server running\n");
		};
		expect(await a.open(storedRow("s"), notCancelled)).toEqual({
			kind: "failed",
			text: "Couldn't open — no server running",
		});
		expect(calls).toEqual([
			["claim", { cwd: HERE, sessionFile: "/s/s.jsonl" }],
			["startFailed", "claimed"],
		]);
	});

	it("an open called off while its pane starts leaves it running in the background", async () => {
		const { actions: a, calls } = actions();
		expect(await a.open(storedRow("s"), () => true)).toEqual({ kind: "cancelled" });
		expect(calls.map((c) => c[0])).toEqual(["claim", "start"]);
	});

	it("a pane that is gone says so rather than tmux's command line; any other failure in tmux's own words", async () => {
		const { actions: a, panes } = actions();
		let stderr = "can't find session: pi-a\n";
		panes.switchTo = () => {
			throw tmuxFailure(stderr);
		};
		expect(await a.open(rowOf(paneRow("pi-a")), notCancelled)).toEqual({
			kind: "failed",
			text: "Couldn't open — that session's pane is gone",
		});
		stderr = "no current client\n";
		expect(await a.open(rowOf(paneRow("pi-a")), notCancelled)).toEqual({
			kind: "failed",
			text: "Couldn't open — no current client",
		});
	});

	it("a starting row, or one with no session file, is refused with what to do", async () => {
		const { actions: a, calls } = actions();
		const starting = rowOf({ id: "s", status: "starting", cwd: HERE, sessionFile: "/s/s.jsonl" });
		expect(await a.open(starting, notCancelled)).toEqual({
			kind: "refused",
			text: "Still starting — try again in a moment",
		});
		const legacy = rowOf({ id: "legacy", status: "stopped", outcome: "failed", cwd: HERE });
		expect(await a.open(legacy, notCancelled)).toEqual({
			kind: "refused",
			text: "No session file recorded — use /resume to reopen its saved conversation",
		});
		expect(calls).toEqual([]);
	});

	it("this window's own session is left to, and a ! command opens on its output", async () => {
		const self = paneRow("pi-self", { activity: "idle" });
		const { actions: a, calls } = actions();
		expect(await a.open(rowOf(self, self), notCancelled)).toEqual({ kind: "left" });
		const shell = rowFromShell({ name: "sh-1", command: "ls", cwd: HERE, createdAt: "", stopped: false });
		expect(await a.open(shell, notCancelled)).toEqual({ kind: "peek" });
		expect(calls).toEqual([]);
	});
});

describe("row actions: stop and delete", () => {
	const shellRow = (stopped: boolean) =>
		rowFromShell({
			name: "sh-1",
			command: "sleep 9",
			cwd: HERE,
			createdAt: "",
			stopped,
			exit: stopped ? "143" : undefined,
		});

	it("stop ends a pane's pi, as quitting does; delete kills the pane, then deletes the row", async () => {
		const { actions: a, calls } = actions();
		const row = rowOf(paneRow("pi-a"));
		expect(await a.stop(row)).toEqual({ kind: "done" });
		expect(calls).toEqual([["end", "pi-a"]]);
		calls.length = 0;
		expect(await a.delete(row, handOff())).toEqual({ kind: "done" });
		expect(calls).toEqual([
			["kill", "pi-a"],
			["delete", "pi-a"],
		]);
	});

	it("a stored row has nothing to stop, and delete only deletes the row", async () => {
		const { actions: a, calls } = actions();
		expect(await a.stop(storedRow("s"))).toEqual({ kind: "refused" });
		expect(await a.delete(storedRow("s"), handOff())).toEqual({ kind: "done" });
		expect(calls).toEqual([["delete", "s"]]);
	});

	it("says why a stop or a delete failed", async () => {
		const { actions: a, panes } = actions({
			delete: async () => {
				throw new Error("daemon away");
			},
		});
		panes.end = () => {
			throw new Error("tmux away");
		};
		expect(await a.stop(rowOf(paneRow("pi-a")))).toEqual({ kind: "failed", text: "Couldn't stop — tmux away" });
		expect(await a.delete(storedRow("s"), handOff())).toEqual({
			kind: "failed",
			text: "Couldn't delete — daemon away",
		});
	});

	it("a pane whose tmux session is already gone counts as stopped", async () => {
		const { actions: a, panes } = actions();
		panes.end = () => {
			throw tmuxFailure("can't find session: pi-a\n");
		};
		expect(await a.stop(rowOf(paneRow("pi-a")))).toEqual({ kind: "done" });
	});

	it("a starting row is neither stopped nor deleted", () => {
		expect(deletable(rowOf({ id: "s", status: "starting", cwd: HERE }))).toBe(false);
		expect(deletable(storedRow("s"))).toBe(true);
	});

	it("a ! command stops while it runs and keeps its row; delete removes it", async () => {
		const { actions: a, calls } = actions();
		expect(await a.stop(shellRow(false))).toEqual({ kind: "done" });
		expect(await a.stop(shellRow(true))).toEqual({ kind: "refused" });
		expect(await a.delete(shellRow(true), handOff())).toEqual({ kind: "done" });
		expect(calls).toEqual([
			["stopShell", "sh-1"],
			["kill", "sh-1"],
		]);
	});

	it("this window's own session stops its turn, and is never ended from here", async () => {
		const { actions: a, calls, stoppedSelf } = actions();
		const self = paneRow("pi-self", { activity: "working" });
		expect(await a.stop(rowOf(self, self))).toEqual({ kind: "done" });
		expect(stoppedSelf()).toBe(1);
		expect(calls).toEqual([]);
	});

	it("a band deletes each of its rows but this window's own and starting ones, a pane killed before its row is deleted", async () => {
		const { actions: a, calls } = actions();
		const self = paneRow("pi-self");
		const rows = [rowOf(paneRow("pi-a")), storedRow("s"), shellRow(true)];
		const band = [rowOf(self, self), ...rows, rowOf({ id: "n", status: "starting", cwd: HERE })];
		expect(bandTargets(band)).toEqual(rows);
		await a.deleteAll(bandTargets(band));
		expect(calls).toEqual([
			["kill", "pi-a"],
			["delete", "pi-a"],
			["delete", "s"],
			["kill", "sh-1"],
		]);
	});

	it("a band delete kills only live panes: a stopped row may still name a pane another pi now runs in", async () => {
		const { actions: a, calls } = actions();
		const left = rowOf({ id: "a", status: "stopped", cwd: HERE, sessionFile: "/s/a.jsonl", pane: "pi-self" });
		await a.deleteAll([left]);
		expect(calls).toEqual([["delete", "a"]]);
	});
});

describe("row actions: deleting this terminal's own session", () => {
	const self = paneRow("pi-self", { activity: "idle" });

	it("starts a pane in agent view, waits for it to draw, switches to it, then unlists, deletes and ends this one", async () => {
		const { actions: a, calls } = actions();
		expect(await a.delete(rowOf(self, self), handOff(calls))).toEqual({ kind: "left" });
		expect(calls).toEqual([
			["leaving"],
			["start", HERE, ["--", "/agent-view"], { [OPEN_VIEW_ENV]: "1", [HIDE_ENV]: "pi-self" }],
			["waitForView", "pi-new1"],
			["switchTo", "pi-new1"],
			["left"],
			["unlist"],
			["delete", "pi-self"],
			["kill", "pi-self"],
		]);
	});

	it("deletes and hides the row its pane goes on as, not the pane's name", async () => {
		const { actions: a, calls } = actions();
		const resumed = paneRow("q", { pane: "pi-self", activity: "idle" });
		const row = collectRows([resumed], self).find((r) => r.self);
		if (!row) throw new Error("no own row");
		await a.delete(row, handOff(calls));
		expect(calls).toContainEqual(["start", HERE, ["--", "/agent-view"], { [OPEN_VIEW_ENV]: "1", [HIDE_ENV]: "q" }]);
		expect(calls).toContainEqual(["delete", "q"]);
		expect(calls).not.toContainEqual(["delete", "pi-self"]);
	});

	it("is called off, killing the new pane, if it ends before drawing", async () => {
		const { actions: a, calls, panes } = actions();
		panes.waitForView = async () => {
			throw new Error("can't find session");
		};
		expect(await a.delete(rowOf(self, self), handOff(calls))).toEqual({
			kind: "failed",
			text: "Couldn't delete — can't find session",
		});
		expect(calls).toEqual([
			["leaving"],
			["start", HERE, ["--", "/agent-view"], { [OPEN_VIEW_ENV]: "1", [HIDE_ENV]: "pi-self" }],
			["kill", "pi-new1"],
		]);
	});
});

describe("row actions: reply", () => {
	it("is a pane's next prompt", async () => {
		const { actions: a, calls } = actions();
		expect(await a.reply(rowOf(paneRow("pi-a", { activity: "idle" })), "and the changelog")).toEqual({
			kind: "done",
		});
		expect(calls).toEqual([["send", "pi-a", { type: "prompt", text: "and the changelog" }]]);
	});

	it("starts a stored session in a pane of its own, claimed first, with the reply as its first prompt", async () => {
		const { actions: a, calls } = actions();
		expect(await a.reply(storedRow("s"), "carry on")).toEqual({ kind: "done" });
		expect(calls).toEqual([
			["claim", { cwd: HERE, sessionFile: "/s/s.jsonl" }],
			["start", HERE, ["--session", "/s/s.jsonl", "--", "carry on"], undefined],
		]);
	});

	it("is refused while a pane waits on a question, and for a row with no pane to start", async () => {
		const { actions: a, calls } = actions();
		expect(await a.reply(rowOf(paneRow("pi-a", { activity: "awaiting_input" })), "yes")).toEqual({
			kind: "refused",
			text: "it's waiting on a question — enter opens it to answer",
		});
		expect(await a.reply(rowOf({ id: "s", status: "starting", cwd: HERE }), "yes")).toEqual({
			kind: "refused",
			text: "enter opens it",
		});
		expect(calls).toEqual([]);
	});

	it("says why it could not be sent", async () => {
		const { actions: a } = actions({
			send: async () => {
				throw new Error("daemon away");
			},
		});
		expect(await a.reply(rowOf(paneRow("pi-a", { activity: "idle" })), "go")).toEqual({
			kind: "failed",
			text: "Couldn't send — daemon away",
		});
	});

	it("/stop aborts a working session's turn; this window's own stops its own", async () => {
		const { actions: a, calls, stoppedSelf } = actions();
		expect(await a.reply(rowOf(paneRow("pi-a")), "/stop")).toEqual({ kind: "done" });
		expect(calls).toEqual([["send", "pi-a", { type: "abort" }]]);
		const self = paneRow("pi-self");
		expect(await a.reply(rowOf(self, self), "/stop")).toEqual({ kind: "done" });
		expect(stoppedSelf()).toBe(1);
	});

	it("to this window's own session is left for it to send; with nothing typed, the row opens", async () => {
		const { actions: a, calls } = actions();
		const self = paneRow("pi-self", { activity: "idle" });
		expect(await a.reply(rowOf(self, self), "next")).toEqual({ kind: "self" });
		expect(await a.reply(rowOf(paneRow("pi-a")), "")).toEqual({ kind: "open" });
		expect(calls).toEqual([]);
	});

	it("a ! command takes only /stop", async () => {
		const { actions: a, calls } = actions();
		const shell = rowFromShell({ name: "sh-1", command: "sleep 9", cwd: HERE, createdAt: "", stopped: false });
		expect(await a.reply(shell, "hello")).toEqual({
			kind: "refused",
			text: "a shell command takes no reply — ctrl+x stops it",
		});
		expect(await a.reply(shell, "")).toEqual({ kind: "refused" });
		expect(await a.reply(shell, "/stop")).toEqual({ kind: "done" });
		expect(calls).toEqual([["stopShell", "sh-1"]]);
	});
});

describe("row actions: pin", () => {
	it("pins or unpins a row, this window's own too", async () => {
		const { actions: a, calls } = actions();
		const self = paneRow("pi-self");
		expect(await a.pin(rowOf(self, self))).toEqual({ kind: "done" });
		expect(await a.pin(rowOf(paneRow("pi-a", { pinned: true })))).toEqual({ kind: "done" });
		expect(calls).toEqual([
			["setMeta", "pi-self", { pinned: true }],
			["setMeta", "pi-a", { pinned: false }],
		]);
	});

	it("leaves a starting row and a ! command unpinned, and says why it could not", async () => {
		const { actions: a, calls } = actions();
		expect(await a.pin(rowOf({ id: "s", status: "starting", cwd: HERE }))).toEqual({ kind: "refused" });
		const shell = rowFromShell({ name: "sh-1", command: "ls", cwd: HERE, createdAt: "", stopped: false });
		expect(await a.pin(shell)).toEqual({ kind: "refused", text: "A shell command can't be pinned" });
		expect(calls).toEqual([]);
		const failing = actions({
			setMeta: async () => {
				throw new Error("daemon away");
			},
		});
		expect(await failing.actions.pin(storedRow("s", { pinned: true }))).toEqual({
			kind: "failed",
			text: "Couldn't unpin — daemon away",
		});
	});
});

describe("row actions: start", () => {
	it("starts a new session's pane with the task as its first prompt, then has the daemon list it as starting", async () => {
		const { actions: a, calls } = actions();
		const started = a.start(HERE, "write the release notes", ["/tmp/shot.png"], {
			provider: "anthropic",
			id: "opus",
		});
		expect(started).toMatchObject({ kind: "started", pane: "pi-new1" });
		expect(calls).toEqual([
			["start", HERE, ["--model", "anthropic/opus", "--", "@/tmp/shot.png", "write the release notes"], undefined],
			["claim", { cwd: HERE, label: "write the release…", pane: "pi-new1" }],
		]);
	});

	it("a pane that cannot be started is claimed nowhere, and says tmux's reason", () => {
		const { actions: a, calls, panes } = actions();
		panes.start = () => {
			throw tmuxFailure("no server running\n");
		};
		expect(a.start(HERE, "", ["/tmp/shot.png"])).toEqual({
			kind: "failed",
			text: "Couldn't start it — no server running",
		});
		expect(calls).toEqual([]);
	});
});

describe("agent view in pane mode", () => {
	it("enter on a working session switches the terminal to its pane at once", async () => {
		const { view, calls, closed, flush } = setup([paneRow("pi-a")]);
		view.handleInput(ENTER);
		await flush();
		expect(calls).toEqual([["switchTo", "pi-a"]]);
		expect(closed()).toBe(1);
	});

	it("a pane that is gone says so rather than tmux's command line, and the roster refreshes", async () => {
		const listed = [paneRow("pi-a")];
		const { view, closed, flush, panes } = setup(listed);
		panes.switchTo = () => {
			throw tmuxFailure("can't find session: pi-a\n");
		};
		listed.length = 0;
		view.handleInput(ENTER);
		await flush();
		const shown = view.render(100).join("\n");
		expect(shown).toContain("Couldn't open — that session's pane is gone");
		expect(shown).not.toContain("Command failed");
		expect(shown).not.toContain("pi-a");
		expect(closed()).toBe(0);
	});

	it("a stored session resumed by a reply stays listed as starting, with its id and focus, until its pane registers", async () => {
		const registry = testRegistry();
		const file = "/nonexistent/s.jsonl";
		const { id } = registry.saveInstance({ cwd: HERE, label: "fix tests", sessionFile: file })!;
		const { view, calls, flush } = setup(listSummaries(registry), undefined, {
			list: async () => listSummaries(registry),
			start: async (spec: ResumeSpec) => {
				const claim = registry.claimStart(spec);
				if (!claim.ok) throw new Error(claim.refused);
				return claim.id;
			},
		});
		await view.onShow();
		view.handleInput(" ");
		for (const ch of "carry on") view.handleInput(ch);
		view.handleInput(ENTER);
		await flush();
		expect(calls).toEqual([["start", HERE, ["--session", file, "--", "carry on"], undefined]]);
		expect(listSummaries(registry)).toEqual([expect.objectContaining({ id, status: "starting" })]);
		expect(focusedLine(view)).toMatch(/fix tests.*starting…/);

		registry.registerExternal(
			{
				id: "pi-new1",
				status: "online",
				cwd: HERE,
				createdAt: new Date().toISOString(),
				sessionFile: file,
				pane: "pi-new1",
			},
			"working",
		);
		expect(listSummaries(registry)).toEqual([expect.objectContaining({ id, status: "online", pane: "pi-new1" })]);
		await waitFor(() => expect(view.render(100).join("\n")).not.toContain("starting…"));
		expect(focusedLine(view)).toContain("fix tests");
		view.close();
	});

	it("a peek whose session goes away ends, rather than sending its reply to the next row", async () => {
		const listed = [paneRow("pi-x", { label: "x" }), paneRow("pi-y", { label: "y" })];
		const { view, calls, flush } = setup(listed);
		const internals = view as unknown as { selectedKey?: string; refresh(): Promise<void> };
		await view.onShow();
		const peeked = internals.selectedKey;
		view.handleInput(" ");
		for (const ch of "deploy") view.handleInput(ch);
		listed.splice(
			listed.findIndex((i) => i.id === peeked),
			1,
		);
		await internals.refresh();
		view.handleInput(ENTER);
		await flush();
		expect(calls.filter(([name]) => name === "send")).toEqual([]);
		view.close();
	});

	it("a row deleted just after a daemon restart is not carried back by the restart's grace", async () => {
		const listed = [paneRow("pi-x", { label: "doomed" }), paneRow("pi-y", { label: "kept" })];
		const { view, flush } = setup(listed);
		const internals = view as unknown as {
			selectedKey?: string;
			restartedAt: number;
			refresh(): Promise<void>;
		};
		await internals.refresh();
		for (let i = 0; i < 4 && !focusedLine(view)?.includes("doomed"); i++) view.handleInput("\x1b[B");
		expect(focusedLine(view)).toContain("doomed");
		// A restarted daemon lists no pane until it beats again; their rows are carried meanwhile.
		internals.restartedAt = Date.now();
		const before = [...listed];
		view.handleInput(CTRL_X);
		view.handleInput(CTRL_X);
		await flush();
		// A poll read before the delete landed answers with the row still in it.
		listed.splice(0, listed.length, ...before);
		await internals.refresh();
		listed.splice(0, listed.length, before[1]);
		await internals.refresh();
		expect(view.render(100).join("\n")).not.toContain("doomed");
		view.close();
	});

	it("a name search focuses its best match as it is typed, then keeps the focus the user moves to", async () => {
		const listed = [paneRow("pi-a1", { label: "alpha one" }), paneRow("pi-a2", { label: "alpha two" })];
		const { view } = setup(listed);
		const internals = view as unknown as { selectedKey?: string; refresh(): Promise<void> };
		await view.onShow();
		for (const ch of "n:alpha") view.handleInput(ch);
		const best = internals.selectedKey;
		view.handleInput("\x1b[B");
		const moved = internals.selectedKey;
		expect(moved).not.toBe(best);
		await internals.refresh();
		expect(internals.selectedKey).toBe(moved);
		view.close();
	});

	it("enter twice on a stored session's reply starts one pane", async () => {
		const stored: InstanceSummary = {
			id: "s",
			status: "stopped",
			cwd: HERE,
			sessionFile: "/s/s.jsonl",
			outcome: "done",
		};
		const { view, calls, flush } = setup([stored]);
		view.handleInput(" ");
		for (const ch of "carry on") view.handleInput(ch);
		view.handleInput(ENTER);
		view.handleInput(ENTER);
		await flush();
		expect(calls.filter(([name]) => name === "start")).toHaveLength(1);
	});

	it("a task starts a new pane with it as the first prompt, listed as starting by the daemon under its pane's id", async () => {
		const registry = testRegistry();
		const { view, calls, flush } = setup([], undefined, {
			list: async () => listSummaries(registry),
			start: async (spec: StartSpec) => {
				calls.push(["claim", spec]);
				if (!("pane" in spec)) throw new Error("a resume");
				registry.paneStarting(spec);
				return spec.pane;
			},
		});
		await view.onShow();
		for (const ch of "write the release notes") view.handleInput(ch);
		view.handleInput(ENTER);
		await flush();
		expect(calls[0]).toEqual(["start", HERE, ["--", "write the release notes"], undefined]);
		expect(focusedLine(view)).toMatch(/write the release….*starting…/);
		registry.registerExternal(
			{ ...paneRow("pi-new1"), label: "release notes", status: "online" } as never,
			"working",
		);
		await waitFor(() => expect(focusedLine(view)).toContain("release notes"));
		view.close();
	});

	it("ctrl+x stops a pane, whose row stays, stopped and focused; ctrl+x again deletes it", async () => {
		const rows = [paneRow("pi-a", { label: "first" }), paneRow("pi-b")];
		const { view, calls, flush, panes } = setup(rows, undefined, { list: async () => rows });
		panes.end = (name) => {
			calls.push(["end", name]);
			// The daemon stops the row in place: the same id, with no pane.
			rows.splice(0, 1, { id: "pi-a", status: "stopped", cwd: HERE, label: "first", sessionFile: "/s/pi-a.jsonl" });
		};
		view.handleInput(CTRL_X);
		await flush();
		expect(calls).toEqual([["end", "pi-a"]]);
		expect(focusedLine(view)).toMatch(/first.*stopped · ctrl\+x again to delete/);

		calls.length = 0;
		view.handleInput(CTRL_X);
		await waitFor(() => expect(calls).toEqual([["delete", "pi-a"]]));
	});

	it("ctrl+x again takes the row out at once, while its delete runs; one that fails comes back", async () => {
		const rows = [paneRow("pi-a", { label: "first", activity: "idle", turns: 1 }), paneRow("pi-b")];
		let fail: (error: Error) => void = () => {};
		const { view, flush } = setup(rows, undefined, {
			list: async () => rows,
			delete: () =>
				new Promise<void>((_, reject) => {
					fail = reject;
				}),
		});
		await view.onShow();
		for (let i = 0; i < 4 && !focusedLine(view)?.includes("first"); i++) view.handleInput("\x1b[B");
		expect(focusedLine(view)).toContain("first");
		view.handleInput(CTRL_X);
		await flush();
		view.handleInput(CTRL_X);
		await flush();
		expect(view.render(100).join("\n")).not.toContain("first");
		fail(new Error("daemon away"));
		await flush();
		const screen = view.render(100).join("\n");
		expect(screen).toContain("first");
		expect(screen).toContain("Couldn't delete — daemon away");
		view.close();
	});

	it("this terminal's own row leaves the list at once while its new pane starts", async () => {
		const self = paneRow("pi-self", { label: "mine", activity: "idle", turns: 1 });
		const { view, flush, panes } = setup([self], self);
		panes.waitForView = () => new Promise(() => {});
		view.handleInput(CTRL_X);
		view.handleInput(CTRL_X);
		await flush();
		const screen = view.render(100).join("\n");
		expect(screen).not.toContain("mine");
		expect(screen).toContain("Deleting…");
	});

	it("deleting this terminal's session keeps this view up, keys ignored, until the new one has drawn", async () => {
		const self = paneRow("pi-self", { activity: "idle" });
		const { view, calls, closed, flush, panes } = setup([self], self);
		let drawn: () => void = () => {};
		panes.waitForView = (name) => {
			calls.push(["waitForView", name]);
			return new Promise((resolve) => {
				drawn = resolve;
			});
		};
		view.handleInput(CTRL_X);
		view.handleInput(CTRL_X);
		await flush();
		view.handleInput(ENTER);
		view.handleInput("\x1b");
		await flush();
		expect(calls.map((c) => c[0])).toEqual(["start", "waitForView"]);
		expect(closed()).toBe(0);
		drawn();
		await waitFor(() => expect(calls.at(-1)).toEqual(["kill", "pi-self"]));
		expect(calls.map((c) => c[0])).toEqual(["start", "waitForView", "switchTo", "unlist", "delete", "kill"]);
	});

	it("a delete of this terminal's session called off says why, and keys work again", async () => {
		const self = paneRow("pi-self", { activity: "idle" });
		const { view, closed, flush, panes } = setup([], self);
		panes.waitForView = async () => {
			throw new Error("can't find session");
		};
		view.handleInput(CTRL_X);
		view.handleInput(CTRL_X);
		await flush();
		expect(view.render(100).join("\n")).toContain("Couldn't delete — can't find session");
		view.handleInput(ENTER);
		await flush();
		expect(closed()).toBe(1);
	});

	it("a view opened by a delete leaves that row out, and reports its first loaded frame once", async () => {
		const drawn = vi.fn();
		const view = new AgentView({
			ui: { terminal: { rows: 40 }, requestRender: () => {} } as unknown as TUI,
			client: {
				list: async () => [paneRow("pi-gone", { label: "deleted one" }), paneRow("pi-a", { label: "kept one" })],
				ensureDaemon: async () => true,
				getDaemonInfo: async () => ({ running: false }),
			} as unknown as OrchestratorClient,
			appName: "bluclawd",
			cwd: HERE,
			home: "/home/me",
			panes: { listShells: () => [], listShellsAsync: async () => [] } as unknown as PaneOps,
			onClose: () => {},
			hide: "pi-gone",
			onDrawn: drawn,
		});
		view.render(100);
		await view.onShow();
		const text = view.render(100).join("\n");
		view.render(100);
		await waitFor(() => expect(drawn).toHaveBeenCalledTimes(1));
		expect(text).toContain("kept one");
		expect(text).not.toContain("deleted one");
		view.close();
	});

	it("a peek reply becomes the pane's next prompt; ctrl+c twice leaves tmux", async () => {
		const { view, calls, flush } = setup([paneRow("pi-a", { activity: "idle", turns: 1 })]);
		view.handleInput(" ");
		for (const ch of "and the changelog") view.handleInput(ch);
		view.handleInput(ENTER);
		await flush();
		expect(calls).toEqual([["send", "pi-a", { type: "prompt", text: "and the changelog" }]]);
		view.handleInput("\x1b");
		view.handleInput("\x03");
		view.handleInput("\x03");
		expect(calls.at(-1)).toEqual(["detach"]);
	});

	it("a blank pane isn't a session: the list can empty, and it registers once asked something", async () => {
		const { view } = setup([]);
		expect(view.render(80).join("\n")).not.toContain("moved to the background");
		const registered: unknown[] = [];
		const client = { register: async (i: unknown) => registered.push(i) } as unknown as OrchestratorClient;
		let asked = false;
		const reg = new SelfRegistration(client, () => (asked ? { cwd: HERE, pane: "pi-self" } : undefined));
		await reg.refresh();
		expect(registered).toEqual([]);
		asked = true;
		await reg.refresh();
		expect(registered).toMatchObject([{ cwd: HERE, pane: "pi-self" }]);
	});

	it("a fork is a session before its first message, so its row stays listed", () => {
		const sessions = (entries: Array<{ type: string }>, parentSession?: string) => ({
			getEntries: () => entries,
			getHeader: () => ({ type: "session" as const, id: "s", timestamp: "", cwd: HERE, parentSession }),
		});
		// pi starts a session with these, before anything is asked.
		const setup = [{ type: "model_change" }, { type: "thinking_level_change" }];
		expect(isBlankPane("pi-self", sessions(setup) as never)).toBe(true);
		expect(isBlankPane("pi-self", sessions(setup, "/s/old.jsonl") as never)).toBe(false);
		expect(isBlankPane("pi-self", sessions([...setup, { type: "message" }]) as never)).toBe(false);
		expect(isBlankPane(undefined, sessions(setup) as never)).toBe(false);
	});

	it("esc returns to this terminal's session, or quits once there is none", () => {
		const own = setup([], paneRow("pi-self", { activity: "idle" }));
		own.view.handleInput("\x1b");
		expect(own.closed()).toBe(1);
		expect(own.calls).toEqual([]);
		const none = setup([paneRow("pi-a")]);
		none.view.handleInput("\x1b");
		expect(none.calls).toEqual([["detach"]]);
	});

	it("unregistering waits for a heartbeat on its way, which would list the session again", async () => {
		const order: string[] = [];
		let land = () => {};
		const client = {
			register: () =>
				new Promise<void>((resolve) => {
					land = () => {
						order.push("register");
						resolve();
					};
				}),
			unregister: async () => {
				order.push("unregister");
			},
		} as unknown as OrchestratorClient;
		const reg = new SelfRegistration(client, () => ({ cwd: HERE, pane: "pi-self" }));
		void reg.refresh();
		const stopped = reg.stop();
		land();
		await stopped;
		await reg.refresh();
		expect(order).toEqual(["register", "unregister"]);
	});

	it("lists every pane as an ordinary row, this terminal's own once", () => {
		const self = paneRow("pi-self");
		const rows = collectRows([paneRow("pi-a"), { ...self, pinned: true }, paneRow("pi-b")], self);
		expect(rows.map((r) => [r.id, r.self])).toEqual([
			["pi-self", true],
			["pi-a", false],
			["pi-b", false],
		]);
		expect(rows[0].pinned).toBe(true);
	});

	it("lists this terminal's own row under the row its pane goes on as, and the session it left as its own row", () => {
		// Pane pi-self resumed stored row q; the session it ran before stays stored under the pane's name.
		const self = paneRow("pi-self");
		// Stored rows are listed first, and may still name the pane they last ran in.
		const left: InstanceSummary = {
			id: "pi-self",
			status: "stopped",
			cwd: HERE,
			sessionFile: "/s/a.jsonl",
			pane: "pi-self",
		};
		const own = paneRow("q", { pane: "pi-self", sortOrder: 2 });
		const rows = collectRows([left, own], self);
		expect(rows.map((r) => [r.id, r.self, r.alive])).toEqual([
			["q", true, true],
			["pi-self", false, false],
		]);
		expect(rows[0].sortOrder).toBe(2);
	});

	it("counts the session a pane left in its footer, leaving out only the row the pane is registered as", () => {
		// Pane pi-self went on with /new as row q; the session it left is stored under the pane's name.
		const left: InstanceSummary = {
			id: "pi-self",
			status: "stopped",
			outcome: "done",
			cwd: HERE,
			sessionFile: "/s/a.jsonl",
		};
		const own = paneRow("q", { pane: "pi-self" });
		const rows = otherRows([left, own, paneRow("pi-a")], "pi-self");
		expect(rows.map((r) => [r.id, r.state])).toEqual([
			["pi-self", "done"],
			["pi-a", "working"],
		]);
	});

	it("lists a pane not registered yet (blank after /new) as unlisted, never as the stored row under its name", () => {
		const self = paneRow("pi-self");
		const left: InstanceSummary = { id: "pi-self", status: "stopped", cwd: HERE, sessionFile: "/s/a.jsonl" };
		const rows = collectRows([left], self);
		expect(rows.map((r) => [r.id, r.self, r.unlisted])).toEqual([
			["self:pi-self", true, true],
			["pi-self", false, undefined],
		]);
	});
});

describe("row actions: an own row not registered yet", () => {
	const self = paneRow("pi-self");
	const own = () => {
		const row = collectRows([], self).find((r) => r.self);
		if (!row) throw new Error("no own row");
		return row;
	};

	it("hands this terminal off without deleting any stored row", async () => {
		const { actions: a, calls } = actions();
		await a.delete(own(), handOff(calls));
		expect(calls.filter(([name]) => name === "delete")).toEqual([]);
		expect(calls.at(-1)).toEqual(["kill", "pi-self"]);
	});

	it("can't be pinned until it is listed", async () => {
		const { actions: a, calls } = actions();
		expect(await a.pin(own())).toEqual({ kind: "refused", text: "It is listed once it has a prompt" });
		expect(calls).toEqual([]);
	});
});

describe("tmux", () => {
	it("starts a pane running this pi, with only the pi state directories passed on", () => {
		vi.stubEnv("PI_SERVER_DIR", "/srv");
		vi.stubEnv("PI_API_KEY", "secret");
		const runs: string[][] = [];
		const tmux = new Tmux("/srv", (args) => {
			runs.push(args);
			return "";
		});
		const name = tmux.newSession({ cwd: HERE, args: ["--session", "/f"], env: { [OPEN_VIEW_ENV]: "1" } });
		const args = runs[0];
		expect(args.slice(0, 6)).toEqual(["new-session", "-d", "-s", name, "-c", HERE]);
		expect(args).toContain("PI_SERVER_DIR=/srv");
		expect(args).toContain(`${PANE_ENV}=${name}`);
		expect(args).toContain(`${OPEN_VIEW_ENV}=1`);
		expect(args.join(" ")).not.toContain("secret");
		expect(args.slice(-2)).toEqual(["--session", "/f"]);
		vi.unstubAllEnvs();
	});

	it("keeps a pane whose new-session timed out after tmux had made it, and fails one tmux never made", () => {
		const runs: string[][] = [];
		let made = true;
		const tmux = new Tmux("/srv", (args) => {
			runs.push(args);
			if (args[0] === "new-session") throw new Error("ETIMEDOUT");
			if (args[0] === "has-session" && !made) throw new Error("can't find session");
			return "";
		});
		const name = tmux.newSession({ cwd: HERE, args: [] });
		expect(runs.at(-1)).toEqual(["has-session", "-t", `=${name}`]);
		made = false;
		expect(() => tmux.newSession({ cwd: HERE, args: [] })).toThrow("ETIMEDOUT");
	});

	it("tells a pane that is gone from one tmux could not be asked about", () => {
		const gone = Object.assign(new Error("tmux failed"), { stderr: "can't find session: =pi-b\n" });
		const tmux = new Tmux("/srv", (args) => {
			if (args.at(-1) === "=pi-b") throw gone;
			if (args.at(-1) === "=pi-c") throw new Error("ETIMEDOUT");
			return "";
		});
		expect(tmux.hasSession("pi-a")).toBe(true);
		expect(tmux.hasSession("pi-b")).toBe(false);
		expect(() => tmux.hasSession("pi-c")).toThrow("ETIMEDOUT");
	});

	it("targets sessions by exact name", () => {
		const runs: string[][] = [];
		const tmux = new Tmux("/srv", (args) => {
			runs.push(args);
			if (args[0] === "display-message")
				throw Object.assign(new Error("gone"), { stderr: "can't find session: pi-b" });
			return "";
		});
		tmux.switchTo("pi-a");
		tmux.kill("pi-b");
		expect(runs).toEqual([
			["switch-client", "-t", "=pi-a"],
			["display-message", "-p", "-t", "=pi-b:", "#{session_id} #{pane_pid}"],
		]);
	});

	it("marks and reads a pane's drawn agent view as a session option", () => {
		const runs: string[][] = [];
		const tmux = new Tmux("/srv", (args) => {
			runs.push(args);
			return "$1 1\n";
		});
		tmux.markViewReady("pi-a");
		expect(tmux.viewReady("pi-a")).toBe(true);
		expect(runs).toEqual([
			["set-option", "-t", "=pi-a:", "@bluclawd_view_ready", "1"],
			["display-message", "-p", "-t", "=pi-a:", "#{session_id} #{@bluclawd_view_ready}"],
		]);
	});

	it("has tmux end a blank pane when its terminal detaches, until it's asked something", () => {
		const runs: string[][] = [];
		const tmux = new Tmux("/srv", (args) => {
			runs.push(args);
			return "";
		});
		tmux.endOnDetach("pi-a", true);
		tmux.endOnDetach("pi-a", false);
		expect(runs).toEqual([
			["set-hook", "-t", "=pi-a:", "client-detached", "kill-session -t =pi-a"],
			["set-hook", "-u", "-t", "=pi-a:", "client-detached"],
		]);
	});

	it("sends keys by name to a pane by exact name", () => {
		const runs: string[][] = [];
		const tmux = new Tmux("/srv", (args) => {
			runs.push(args);
			return "";
		});
		tmux.sendKeys("pi-a", ["Down", "Enter"]);
		expect(runs).toEqual([["send-keys", "-t", "=pi-a:", "Down", "Enter"]]);
	});

	it("tells a session or server that is not there from any other failure", () => {
		const failed = (stderr: string) => Object.assign(new Error(`Command failed: tmux\n${stderr}`), { stderr });
		expect(Tmux.gone(failed("can't find session: pi-a\n"))).toBe(true);
		expect(Tmux.gone(failed("can't find pane: %3\n"))).toBe(true);
		expect(Tmux.gone(failed("no server running on /srv/tmux.sock\n"))).toBe(true);
		expect(Tmux.gone(failed("error connecting to /srv/tmux.sock (No such file or directory)\n"))).toBe(true);
		expect(Tmux.gone(failed("server exited unexpectedly\n"))).toBe(false);
		expect(Tmux.gone(failed("error connecting to /srv/tmux.sock (Permission denied)\n"))).toBe(false);
		// What the command sent is no evidence: only tmux's own complaint is.
		expect(Tmux.gone(new Error("Command failed: tmux send-keys -l -- can't find session"))).toBe(false);
		expect(Tmux.gone(Object.assign(new Error("spawnSync tmux ETIMEDOUT"), { code: "ETIMEDOUT", stderr: "" }))).toBe(
			false,
		);
	});

	it("words a failure by tmux's own complaint, not the command that failed", () => {
		expect(Tmux.reason(tmuxFailure("no current client\n"))).toBe("no current client");
		expect(Tmux.reason(Object.assign(new Error("spawnSync tmux ETIMEDOUT"), { stderr: "" }))).toBe(
			"spawnSync tmux ETIMEDOUT",
		);
		expect(Tmux.reason("odd")).toBe("odd");
	});

	it("never ends a session it cannot SIGKILL the pi of: a hung-up pi would carry it on", () => {
		const runs: string[][] = [];
		const tmux = new Tmux("/srv", (args) => {
			runs.push(args);
			return "$1 \n";
		});
		expect(() => tmux.kill("pi-b")).toThrow("couldn't find");
		expect(runs.map((r) => r[0])).toEqual(["display-message"]);
	});

	it("takes a session tmux prints nothing for as gone: display-message does not fail for it", () => {
		const runs: string[][] = [];
		const tmux = new Tmux("/srv", (args) => {
			runs.push(args);
			return " \n";
		});
		tmux.kill("pi-b");
		expect(runs.map((r) => r[0])).toEqual(["display-message"]);
		let error: unknown;
		try {
			tmux.viewReady("pi-b");
		} catch (e) {
			error = e;
		}
		expect(Tmux.gone(error)).toBe(true);
	});

	it("fails a kill tmux could not look up, rather than taking the pi for gone", () => {
		const tmux = new Tmux("/srv", () => {
			throw Object.assign(new Error("Command failed"), { stderr: "spawnSync tmux ETIMEDOUT" });
		});
		expect(() => tmux.kill("pi-b")).toThrow("ETIMEDOUT");
	});
});

describe("paneArgs", () => {
	it("hands the pane the session its launcher resolved, keeping every other argument", () => {
		expect(paneArgs(["-c", "--model", "x", "fix it"], import.meta.filename)).toEqual([
			"--session",
			import.meta.filename,
			"--model",
			"x",
			"fix it",
		]);
		expect(paneArgs(["--session", "abc", "--", "-c"], import.meta.filename)).toEqual([
			"--session",
			import.meta.filename,
			"--",
			"-c",
		]);
		expect(paneArgs(["-r"], undefined)).toEqual(["-r"]);
	});
});

describe("promptOptions", () => {
	it("runs a phone's slash command as typed on the Mac, and always queues a prompt behind a turn pi may have started", () => {
		const queued = { deliverAs: "followUp" };
		expect(promptOptions({ text: "/skill:review the diff" })).toEqual({ ...queued, expandPromptTemplates: true });
		expect(promptOptions({ text: "fix /tmp/a" })).toEqual(queued);
		expect(promptOptions({ text: " /fix" })).toEqual(queued);
		// pi would run an extension command with its text alone: the images go as a plain message.
		expect(promptOptions({ text: "/fix", images: [{}] })).toEqual(queued);
		expect(promptOptions({ text: "/fix", images: [] })).toEqual({ ...queued, expandPromptTemplates: true });
	});
});

describe("leaveViewAction", () => {
	it("ends the terminal's own session while idle, and leaves it running mid-turn as any other", () => {
		expect(leaveViewAction({ startedHere: true, idle: true, blank: false })).toBe("quit");
		expect(leaveViewAction({ startedHere: true, idle: false, blank: false })).toBe("detach");
		expect(leaveViewAction({ startedHere: false, idle: true, blank: false })).toBe("detach");
		expect(leaveViewAction({ startedHere: false, idle: true, blank: true })).toBe("kill");
	});
});

describe("promptContent", () => {
	it("puts an [Image #N] line per image under the text, for the Mac's chat, which shows no image", () => {
		expect(promptContent({ text: "look" })).toBe("look");
		expect(promptContent({ text: "look", images: [] })).toBe("look");
		const png = { mimeType: "image/png", data: "AA==" };
		expect(promptContent({ text: "look", images: [png, png] })).toEqual([
			{ type: "text", text: "look\n\n[Image #1]\n[Image #2]" },
			{ type: "image", ...png },
			{ type: "image", ...png },
		]);
	});
});

describe("shutdownPlan", () => {
	it("keeps the row for the pane's next session only when it carries on this one", () => {
		const keep = { await: true, unregister: false };
		const drop = { await: true, unregister: true };
		// A fork is a session of its own; the one it came from is left stopped.
		expect(shutdownPlan({ reason: "fork", targetSessionFile: "/s/b.jsonl" }, "/s/a.jsonl")).toEqual(drop);
		expect(shutdownPlan({ reason: "reload" }, "/s/a.jsonl")).toEqual(keep);
		expect(shutdownPlan({ reason: "resume", targetSessionFile: "/s/a.jsonl" }, "/s/a.jsonl")).toEqual(keep);
		expect(shutdownPlan({ reason: "resume" }, undefined)).toEqual(keep);
		expect(shutdownPlan({ reason: "resume", targetSessionFile: "/s/b.jsonl" }, "/s/a.jsonl")).toEqual(drop);
		// /new carries the row on, as /clear does in Claude Code: the old session is left on disk only.
		expect(shutdownPlan({ reason: "new", targetSessionFile: "/s/b.jsonl" }, "/s/a.jsonl")).toEqual(keep);
		expect(shutdownPlan({ reason: "quit" }, "/s/a.jsonl")).toEqual({ await: false, unregister: true });
	});
});

describe("daemon: pane registrations", () => {
	const rec = (id: string, createdAt: string) => ({ id, status: "online" as const, cwd: HERE, createdAt, pane: id });

	it("keeps a pane's age and pin across heartbeats, delivers queued messages once, and deletes it", async () => {
		const supervisor = testRegistry();
		supervisor.registerExternal(rec("pi-a", "2026-01-01T00:00:00Z"), "idle", 1000);
		supervisor.setInstanceMeta("pi-a", { pinned: true });
		expect(supervisor.sendExternal("pi-a", { type: "abort" })).toBe(true);
		supervisor.registerExternal(rec("pi-a", "2026-06-01T00:00:00Z"), "idle", 2000);
		const [entry] = supervisor.listExternalInstances(2000);
		expect(entry.record).toMatchObject({ createdAt: "2026-01-01T00:00:00Z", pinned: true, pane: "pi-a" });
		expect(supervisor.drainExternal("pi-a")).toEqual([{ type: "abort" }]);
		expect(supervisor.drainExternal("pi-a")).toEqual([]);
		expect(await supervisor.deleteInstance("pi-a")).toBe(true);
		expect(supervisor.listExternalInstances(2000)).toEqual([]);
		expect(supervisor.sendExternal("pi-a", { type: "abort" })).toBe(false);
	});

	it("delivers everything queued, in order, in one drain", () => {
		const supervisor = testRegistry();
		supervisor.registerExternal(rec("pi-a", "2026-01-01T00:00:00Z"), "idle");
		supervisor.sendExternal("pi-a", { type: "rename", name: "x" });
		supervisor.sendExternal("pi-a", { type: "prompt", text: "first" });
		supervisor.sendExternal("pi-a", { type: "abort" });
		expect(supervisor.drainExternal("pi-a")).toEqual([
			{ type: "rename", name: "x" },
			{ type: "prompt", text: "first" },
			{ type: "abort" },
		]);
		expect(supervisor.drainExternal("pi-a")).toEqual([]);
	});
});
