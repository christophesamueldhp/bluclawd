import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ServerSupervisor } from "../daemon/supervisor.ts";
import { setSharedTheme } from "../ext/_shared/theme.ts";
import { AgentView, type PaneOps } from "../ext/agent-view/agent-view.ts";
import { paneArgs } from "../ext/agent-view/index.ts";
import type { InstanceSummary, OrchestratorClient } from "../ext/agent-view/orchestrator-client.ts";
import { collectRows } from "../ext/agent-view/rows.ts";
import { SelfRegistration } from "../ext/agent-view/self-registration.ts";
import { CONTINUE_ENV, OPEN_VIEW_ENV, PANE_ENV, Tmux } from "../ext/agent-view/tmux.ts";

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

function setup(instances: InstanceSummary[], self?: InstanceSummary) {
	const calls: Calls = [];
	const record =
		(name: string) =>
		async (...args: unknown[]) => {
			calls.push([name, ...args]);
		};
	const client = {
		list: async () => instances,
		ensureDaemon: async () => true,
		getDaemonInfo: async () => ({ running: false }),
		send: record("send"),
		delete: record("delete"),
		setMeta: record("setMeta"),
	} as unknown as OrchestratorClient;
	let started = 0;
	const panes: PaneOps = {
		current: "pi-self",
		switchTo: (name) => calls.push(["switchTo", name]),
		start: (cwd, args, env) => {
			calls.push(["start", cwd, args, env]);
			return `pi-new${++started}`;
		},
		kill: (name) => calls.push(["kill", name]),
		unlist: async () => {
			calls.push(["unlist"]);
		},
		detach: () => calls.push(["detach"]),
	};
	let closed = 0;
	const view = new AgentView({
		ui: { terminal: { rows: 40 }, requestRender: () => {} } as unknown as TUI,
		client,
		appName: "bluclawd",
		cwd: HERE,
		home: "/home/me",
		self: () => self,
		onClose: () => closed++,
		panes,
	});
	view.setInstancesForTest(instances);
	const flush = async () => {
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
	};
	return { view, calls, closed: () => closed, flush };
}

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

describe("agent view in pane mode", () => {
	it("enter on a working session switches the terminal to its pane at once", async () => {
		const { view, calls, closed, flush } = setup([paneRow("pi-a")]);
		view.handleInput(ENTER);
		await flush();
		expect(calls).toEqual([["switchTo", "pi-a"]]);
		expect(closed()).toBe(1);
	});

	it("a stored session gets a pane of its own, then the terminal switches to it", async () => {
		const stored: InstanceSummary = {
			id: "s",
			status: "stopped",
			cwd: HERE,
			sessionFile: "/s/s.jsonl",
			outcome: "done",
		};
		const { view, calls, flush } = setup([stored]);
		view.handleInput(ENTER);
		await flush();
		expect(calls).toEqual([
			["start", HERE, ["--session", "/s/s.jsonl"], undefined],
			["delete", "s"],
			["switchTo", "pi-new1"],
		]);
	});

	it("a task starts a new pane with it as the first prompt; its row replaces the placeholder", async () => {
		const instances: InstanceSummary[] = [];
		const { view, calls, flush } = setup(instances);
		for (const ch of "write the release notes") view.handleInput(ch);
		view.handleInput(ENTER);
		expect(calls).toEqual([["start", HERE, ["--", "write the release notes"], undefined]]);
		expect(view.selectedKeyForTest()).toBe("pending:pi-new1");
		view.setInstancesForTest([paneRow("pi-new1")]);
		await flush();
		expect(view.selectedKeyForTest()).toBe("pi-new1");
	});

	it("ctrl+x stops a pane's turn, then ends its pi and removes its row", async () => {
		const { view, calls, flush } = setup([paneRow("pi-a")]);
		view.handleInput(CTRL_X);
		await flush();
		expect(calls).toEqual([["send", "pi-a", { type: "abort" }]]);
		view.handleInput(CTRL_X);
		await flush();
		expect(calls.slice(1)).toEqual([
			["kill", "pi-a"],
			["delete", "pi-a"],
		]);
	});

	it("ctrl+x twice on this terminal's own session moves it to a new one in agent view, then ends it", async () => {
		const self = paneRow("pi-self", { activity: "idle" });
		const { view, calls, flush } = setup([], self);
		view.handleInput(CTRL_X);
		view.handleInput(CTRL_X);
		await flush();
		expect(calls).toEqual([
			["start", HERE, [], { [OPEN_VIEW_ENV]: "1" }],
			["switchTo", "pi-new1"],
			["unlist"],
			["delete", "pi-self"],
			["kill", "pi-self"],
		]);
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

	it("esc returns to this terminal's session, or quits once there is none, as in Claude Code", () => {
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
		const name = tmux.newSession({ cwd: HERE, args: ["--session", "/f"], env: { [CONTINUE_ENV]: "1" } });
		const args = runs[0];
		expect(args.slice(0, 6)).toEqual(["new-session", "-d", "-s", name, "-c", HERE]);
		expect(args).toContain("PI_SERVER_DIR=/srv");
		expect(args).toContain(`${PANE_ENV}=${name}`);
		expect(args).toContain(`${CONTINUE_ENV}=1`);
		expect(args.join(" ")).not.toContain("secret");
		expect(args.slice(-2)).toEqual(["--session", "/f"]);
		vi.unstubAllEnvs();
	});

	it("targets sessions by exact name", () => {
		const runs: string[][] = [];
		const tmux = new Tmux("/srv", (args) => {
			runs.push(args);
			if (args[0] === "display-message") throw new Error("gone");
			return "";
		});
		tmux.switchTo("pi-a");
		tmux.kill("pi-b");
		expect(runs).toEqual([
			["switch-client", "-t", "=pi-a"],
			["display-message", "-p", "-t", "=pi-b:", "#{pane_pid}"],
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

	it("never ends a session it cannot SIGKILL the pi of: a hung-up pi would carry it on", () => {
		const runs: string[][] = [];
		const tmux = new Tmux("/srv", (args) => {
			runs.push(args);
			return "\n";
		});
		expect(() => tmux.kill("pi-b")).toThrow("couldn't find");
		expect(runs.map((r) => r[0])).toEqual(["display-message"]);
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

describe("daemon: pane registrations", () => {
	const rec = (id: string, createdAt: string) => ({ id, status: "online" as const, cwd: HERE, createdAt, pane: id });

	it("keeps a pane's age and pin across heartbeats, delivers queued messages once, and deletes it", async () => {
		const supervisor = new ServerSupervisor();
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
});
