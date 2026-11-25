import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allows, deleteHtml, pinHtml, renameHtml } from "#remote-web/controls.js";
import { settingsHtml } from "#remote-web/statusbar.js";
import type { InstanceSummary, PaneReport } from "../daemon/ipc/protocol.ts";
import { type RemoteServer, startRemoteServer } from "../daemon/remote/http.ts";
import { RemoteStore } from "../daemon/remote/pairing.ts";
import { decide, type PhoneAction, phoneSession } from "../daemon/remote/phone-control.ts";
import type { ActionVerdict, ChatAction, ListedRemoteSession } from "../daemon/remote/sessions.ts";

type State = "live" | "silent" | "starting" | "stored";
const STATES: State[] = ["live", "silent", "starting", "stored"];
const KINDS: ChatAction[] = ["message", "settings", "rename", "pin", "delete", "tasks"];

const allowed: ActionVerdict = { act: true };
const refused = (reason: Extract<ActionVerdict, { act: false }>["reason"]): ActionVerdict => ({ act: false, reason });
const toPi = {
	live: allowed,
	silent: refused("silent"),
	starting: refused("starting"),
	stored: refused("not_running"),
};

const OPEN: Record<ChatAction, Record<State, ActionVerdict>> = {
	message: toPi,
	settings: toPi,
	rename: { live: allowed, silent: refused("silent"), starting: allowed, stored: allowed },
	pin: { live: allowed, silent: allowed, starting: allowed, stored: allowed },
	delete: { live: refused("running"), silent: refused("running"), starting: refused("starting"), stored: allowed },
	tasks: toPi,
};
const verdictOf = (state: State, open: boolean, kind: ChatAction) =>
	open ? OPEN[kind][state] : refused("no_terminal");

const CODES = {
	no_terminal: "pi_not_open",
	silent: "session_silent",
	starting: "session_not_running",
	not_running: "session_not_running",
	running: "session_running",
};
function codeOf(state: State, open: boolean, kind: ChatAction, gate: boolean): string | undefined {
	const verdict = verdictOf(state, open, kind);
	if (verdict.act) return undefined;
	if (kind === "tasks" && (open || !gate) && (state === "starting" || state === "stored")) return "unknown_task";
	return CODES[verdict.reason];
}

const REQUESTS: Record<ChatAction, { method: string; path: string; body?: object; action: PhoneAction }> = {
	message: { method: "POST", path: "/prompt", body: { text: "next" }, action: { type: "prompt", text: "next" } },
	settings: {
		method: "POST",
		path: "/model",
		body: { provider: "openai", id: "gpt-5" },
		action: { type: "model", provider: "openai", id: "gpt-5" },
	},
	rename: { method: "POST", path: "/rename", body: { name: "later" }, action: { type: "rename", name: "later" } },
	pin: { method: "POST", path: "/pin", body: { pinned: true }, action: { type: "pin", pinned: true } },
	delete: { method: "DELETE", path: "", action: { type: "delete" } },
	tasks: { method: "POST", path: "/tasks/f2/stop", body: {}, action: { type: "stop_task", taskId: "f2" } },
};

const gpt = { provider: "openai", id: "gpt-5", name: "GPT-5" };
const report: PaneReport = {
	model: gpt,
	models: [gpt],
	thinkingLevels: ["off", "low"],
	trust: "always",
	tasks: [{ id: "f2", kind: "shell", label: "sleep 60", startedAt: 2 }],
};
const pane = (id: State, extra: Partial<InstanceSummary> = {}): InstanceSummary => ({
	id,
	status: "online",
	cwd: "/p",
	external: true,
	activity: "idle",
	sessionFile: `/s/${id}.jsonl`,
	pane: `pi-${id}`,
	...extra,
});
const instances: InstanceSummary[] = [
	pane("live"),
	pane("silent", { silent: true }),
	{ id: "starting", status: "starting", cwd: "/p", sessionFile: "/s/starting.jsonl" },
	{ id: "stored", status: "stopped", cwd: "/p", sessionFile: "/s/stored.jsonl" },
];

const cells = STATES.flatMap((state) =>
	[true, false].flatMap((open) => KINDS.map((kind) => ({ state, open, kind }) as const)),
);
const name = ({ state, open, kind }: (typeof cells)[number]) =>
	`${kind} on a ${state} row, ${open ? "a terminal showing pi" : "no terminal"}`;

describe("the Chat verdict on each kind of action", () => {
	let dir: string;
	let server: RemoteServer;
	let base: string;
	let token: string;
	let terminalOpen = true;
	let terminalAsked = 0;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "bluclawd-chat-verdict-"));
		const store = new RemoteStore(join(dir, "remote.json"));
		server = await startRemoteServer(
			{
				store,
				webDir: dir,
				listInstances: () => instances,
				send: async () => true,
				launch: () => undefined,
				startSession: () => "pi-new",
				claimStart: () => ({ ok: true, id: "pi-new" }),
				paneStarting: () => {},
				startFailed: () => {},
				terminalOpen: () => {
					terminalAsked++;
					return terminalOpen;
				},
				report: () => report,
				renameInstance: () => true,
				setPinned: () => true,
				deleteInstance: () => true,
			},
			0,
		);
		base = `http://127.0.0.1:${server.port}`;
		const { code } = store.createCode();
		const res = await fetch(`${base}/api/pair`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code, deviceName: "iPhone" }),
		});
		token = ((await res.json()) as { token: string }).token;
	});

	afterAll(async () => {
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	});

	async function listed(open: boolean): Promise<ListedRemoteSession[]> {
		terminalOpen = open;
		const res = await fetch(`${base}/api/sessions`, { headers: { authorization: `Bearer ${token}` } });
		return ((await res.json()) as { sessions: ListedRemoteSession[] }).sessions;
	}

	async function rowOf(state: State, open: boolean): Promise<ListedRemoteSession> {
		const row = (await listed(open)).find((s) => s.id === state);
		if (!row) throw new Error(`no row ${state}`);
		return row;
	}

	describe("listed with each row", () => {
		it.each(cells.map((cell) => [name(cell), cell] as const))("%s", async (_, { state, open, kind }) => {
			const row = (await listed(open)).find((s) => s.id === state);
			expect(row?.actions[kind]).toEqual(verdictOf(state, open, kind));
		});

		it("carries each row's verdict on pi, whatever the terminal", async () => {
			for (const open of [true, false]) {
				expect(Object.fromEntries((await listed(open)).map((s) => [s.id, s.verdict]))).toEqual({
					live: { act: true },
					silent: { act: false, reason: "silent" },
					starting: { act: false, reason: "starting" },
					stored: { act: false, reason: "not_running" },
				});
			}
		});
	});

	describe("refused by Phone control exactly as listed", () => {
		it.each(cells.map((cell) => [name(cell), cell] as const))("%s", (_, { state, open, kind }) => {
			const session = phoneSession(
				{ listInstances: () => instances, report: () => report, terminalOpen: () => open },
				state,
			);
			if (!session) throw new Error(`no session ${state}`);
			const outcome = decide(session, REQUESTS[kind].action);
			const code = codeOf(state, open, kind, false);
			if (code) expect(outcome).toEqual({ error: code });
			else expect(outcome).not.toHaveProperty("error");
		});
	});

	describe("refused over HTTP, by the gate or Phone control, exactly as listed", () => {
		it.each(cells.map((cell) => [name(cell), cell] as const))("%s", async (_, { state, open, kind }) => {
			terminalOpen = open;
			const { method, path, body } = REQUESTS[kind];
			const res = await fetch(`${base}/api/sessions/${state}${path}`, {
				method,
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				...(body ? { body: JSON.stringify(body) } : {}),
			});
			const { error } = (await res.json()) as { error?: string };
			const code = codeOf(state, open, kind, true);
			expect(code ? [res.status, error] : res.status < 300).toEqual(
				code ? [code === "unknown_task" ? 404 : 409, code] : true,
			);
		});
	});

	it("never asks whether a terminal shows pi for a read, which may wait on tmux", async () => {
		terminalAsked = 0;
		for (const path of ["/status", "/commands", "/messages", "/tasks/f2/output"]) {
			const res = await fetch(`${base}/api/sessions/live${path}`, { headers: { authorization: `Bearer ${token}` } });
			expect(res.status, path).not.toBe(409);
		}
		expect(terminalAsked).toBe(0);
	});

	describe("built on the phone only when allowed", () => {
		it("allows nothing on a row listed without actions", async () => {
			const { actions: _actions, ...unlisted } = await rowOf("live", true);
			expect(KINDS.map((kind) => allows(unlisted as ListedRemoteSession, kind))).toEqual(KINDS.map(() => false));
		});

		it.each(cells.map((cell) => [name(cell), cell] as const))("%s", async (_, { state, open, kind }) => {
			const row = await rowOf(state, open);
			const act = verdictOf(state, open, kind).act;
			expect(allows(row, kind)).toBe(act);
			const built = {
				pin: pinHtml(row),
				rename: renameHtml(row),
				delete: deleteHtml(row, false),
				settings: settingsHtml(report, allows(row, "settings")).includes("data-pick") ? "pickers" : "",
			};
			if (kind in built) expect(built[kind as keyof typeof built] !== "").toBe(act);
		});
	});
});
