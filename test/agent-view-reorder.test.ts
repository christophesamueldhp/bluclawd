import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { handleIpcRequest, listSummaries } from "../daemon/handler.ts";
import type { InstanceSummary } from "../daemon/orchestrator-client.ts";
import { type AgentRow, buildBands } from "../daemon/rows.ts";
import { ServerSupervisor } from "../daemon/supervisor.ts";
import type { ShellInfo } from "../daemon/tmux.ts";
import { setSharedTheme } from "../ext/_shared/theme.ts";
import { AgentView, type PaneOps } from "../ext/agent-view/agent-view.ts";
import { waitFor } from "./helpers/wait-for.ts";

const SHIFT_DOWN = "\x1b[1;2B";
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(() =>
	setSharedTheme({
		fg: (_c: string, s: string) => s,
		bg: (_c: string, s: string) => s,
		bold: (s: string) => s,
		getBgAnsi: () => "",
		getColorMode: () => "truecolor",
	} as unknown as Theme),
);

/** A real daemon supervisor behind a client whose writes take a moment, as over the socket. */
function world() {
	const dir = mkdtempSync(join(tmpdir(), "reorder-"));
	const sup = new ServerSupervisor({ now: () => Date.now(), tmux: { hasSession: () => true }, dir } as never);
	const beat = (id: string, activity: "idle" | "working", minutesAgo: number, pane = id) => {
		const file = join(dir, `${id}.jsonl`);
		writeFileSync(file, "");
		const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
		sup.registerExternal(
			{
				id: pane,
				status: "online",
				cwd: dir,
				createdAt: at,
				finishedAt: at,
				sessionFile: file,
				pane,
				label: id,
				turns: 1,
			},
			activity,
		);
	};
	const metaCalls: string[] = [];
	const client = {
		list: async () => listSummaries(sup),
		ensureDaemon: async () => true,
		getDaemonInfo: async () => ({ running: false }),
		setMeta: async (id: string, meta: { sortOrder?: number; pinned?: boolean }) => {
			metaCalls.push(id);
			await wait(5);
			const res = await handleIpcRequest(sup, { type: "meta", instanceId: id, ...meta } as never);
			if (!res.ok) throw new Error((res as { error: string }).error);
		},
	};
	return { dir, sup, beat, client, metaCalls };
}

const views: AgentView[] = [];
afterEach(() => {
	for (const v of views.splice(0)) (v as unknown as { teardown(): void }).teardown();
});

function view(w: ReturnType<typeof world>, extra: { self?: () => InstanceSummary; shells?: ShellInfo[] } = {}) {
	const panes = {
		current: "self",
		listShells: () => extra.shells ?? [],
		switchTo() {},
		start: () => "x",
		waitForView: async () => {},
		end() {},
		kill() {},
		unlist: async () => {},
		detach() {},
		startShell: () => "x",
		stopShell() {},
		capture: () => [],
	} as unknown as PaneOps;
	const v = new AgentView({
		ui: { terminal: { rows: 60 }, requestRender: () => {} } as unknown as TUI,
		client: w.client as never,
		panes,
		appName: "bluclawd",
		cwd: w.dir,
		home: "/nohome",
		onClose: () => {},
		...(extra.self ? { self: extra.self } : {}),
	});
	views.push(v);
	return v;
}

/** Every press's writes landed and the daemon's order is what shows. */
const saved = (v: AgentView) =>
	waitFor(() => (v as unknown as { pendingOrder: Map<string, number> }).pendingOrder.size === 0);

const NAMES = /\b(pa|pb|pc|me|!ls)\b/;
const order = (v: AgentView) =>
	v
		.render(100)
		.map(plain)
		.flatMap((l) => NAMES.exec(l)?.[1] ?? []);

describe("agent view: shift+↑/↓", () => {
	it("moves a row one step per press, however fast the presses come", async () => {
		const w = world();
		w.beat("pa", "idle", 1);
		w.beat("pb", "idle", 2);
		w.beat("pc", "idle", 3);
		const v = view(w);
		await v.onShow();
		expect(order(v)).toEqual(["pa", "pb", "pc"]);
		v.handleInput(SHIFT_DOWN);
		expect(order(v)).toEqual(["pb", "pa", "pc"]);
		v.handleInput(SHIFT_DOWN);
		expect(order(v)).toEqual(["pb", "pc", "pa"]);
		await saved(v);
		expect(order(v)).toEqual(["pb", "pc", "pa"]);
		expect(listSummaries(w.sup).find((i) => i.id === "pa")?.sortOrder).toBe(2);
	});

	it("moves this window's own row, which is focused when the view opens", async () => {
		const w = world();
		w.beat("me", "idle", 0, "self");
		w.beat("pa", "idle", 1);
		const self: InstanceSummary = {
			id: "self",
			status: "online",
			activity: "idle",
			cwd: w.dir,
			label: "me",
			turns: 1,
			external: true,
			pane: "self",
			createdAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
		};
		const v = view(w, { self: () => self });
		await v.onShow();
		expect(order(v)).toEqual(["me", "pa"]);
		v.handleInput(SHIFT_DOWN);
		await saved(v);
		expect(order(v)).toEqual(["pa", "me"]);
		expect(w.metaCalls).toContain("self");
	});

	it("leaves a `!` command out of the order instead of failing to save it", async () => {
		const w = world();
		w.beat("pa", "idle", 1);
		w.beat("pb", "idle", 2);
		const shells: ShellInfo[] = [
			{
				name: "sh-1",
				command: "ls",
				cwd: w.dir,
				createdAt: new Date(Date.now() - 30_000).toISOString(),
				exit: "0",
				lastLine: "ok",
			} as ShellInfo,
		];
		const v = view(w, { shells });
		await v.onShow();
		v.handleInput(SHIFT_DOWN);
		await saved(v);
		expect(w.metaCalls.sort()).toEqual(["pa", "pb"]);
		expect(v.render(100).map(plain).join("\n")).not.toContain("Couldn't save order");
	});
});

describe("manual order", () => {
	const row = (id: string, extra: Partial<AgentRow> = {}): AgentRow => ({
		id,
		label: id,
		cwd: "/p",
		state: "done",
		alive: true,
		detail: "",
		pinned: false,
		self: false,
		...extra,
	});

	it("puts ordered rows first in the directory view, the rest oldest first", () => {
		const rows = [
			row("old", { createdAt: "2026-01-01T00:00:00Z" }),
			row("second", { sortOrder: 1, createdAt: "2026-01-03T00:00:00Z" }),
			row("first", { sortOrder: 0, createdAt: "2026-01-04T00:00:00Z" }),
			row("new", { createdAt: "2026-01-05T00:00:00Z" }),
		];
		const [band] = buildBands(rows, "directory", (p) => p);
		expect(band.rows.map((r) => r.id)).toEqual(["first", "second", "old", "new"]);
	});

	it("breaks a tie in the state view by recency, so rows never swap at random", () => {
		const rows = [
			row("older", { sortOrder: 0, updatedAt: "2026-01-01T00:00:00Z" }),
			row("newer", { sortOrder: 0, updatedAt: "2026-01-02T00:00:00Z" }),
		];
		const idle = buildBands(rows, "state", (p) => p).find((b) => b.key === "idle");
		expect(idle?.rows.map((r) => r.id)).toEqual(["newer", "older"]);
	});
});
