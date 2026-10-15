import { describe, expect, it } from "vitest";
import type { RemoteSession } from "../daemon/remote/sessions.ts";
import type { TmuxClient } from "../daemon/tmux.ts";
import { notificationEscape, shownBy, watchSessions } from "../ext/notifications/index.ts";

const session = (id: string, state: RemoteSession["state"], detail = ""): RemoteSession => ({
	id,
	label: `task ${id}`,
	cwd: "/p",
	band: state === "working" ? "working" : state === "needs" ? "needs" : "idle",
	state,
	alive: true,
	resumable: false,
	detail,
});

describe("notificationEscape", () => {
	it("writes OSC 777, wrapped for tmux's passthrough with every ESC doubled", () => {
		expect(notificationEscape("task a", "Done", "xterm-ghostty", false)).toBe("\x1b]777;notify;task a;Done\x07");
		expect(notificationEscape("task a", "Done", "xterm-ghostty", true)).toBe(
			"\x1bPtmux;\x1b\x1b]777;notify;task a;Done\x07\x1b\\",
		);
	});

	it("writes OSC 99 for kitty", () => {
		expect(notificationEscape("t", "b", "xterm-kitty", false)).toBe(
			"\x1b]99;i=1:d=0;t\x1b\\\x1b]99;i=1:p=body;b\x1b\\",
		);
	});

	it("keeps control characters out, and a title's ; from ending it early", () => {
		expect(notificationEscape("a;b\x07", "x\x1by\nz", "xterm-ghostty", false)).toBe("\x1b]777;notify;a,b;xy z\x07");
	});
});

describe("shownBy", () => {
	const clients: TmuxClient[] = [
		{ session: "pi-b", termname: "xterm-ghostty" },
		{ session: "pi-a", termname: "xterm-kitty" },
	];

	it("is the client showing this pane, when no other terminal shows a pane named before it", () => {
		expect(shownBy(clients, "pi-a")).toEqual({ session: "pi-a", termname: "xterm-kitty" });
		expect(shownBy(clients, "pi-b")).toBeUndefined();
	});

	it("is nothing for a pane no terminal shows", () => {
		expect(shownBy(clients, "pi-c")).toBeUndefined();
		expect(shownBy([], "pi-a")).toBeUndefined();
	});
});

describe("watchSessions", () => {
	function setup(pane: string, clients: TmuxClient[]) {
		let sessions: RemoteSession[] = [];
		const written: string[] = [];
		let tmuxCalls = 0;
		const tick = watchSessions({
			pane,
			sessions: async () => sessions,
			clients: () => {
				tmuxCalls++;
				return clients;
			},
			write: (text) => written.push(text),
		});
		return {
			tick,
			written,
			set: (next: RemoteSession[]) => {
				sessions = next;
			},
			tmuxCalls: () => tmuxCalls,
		};
	}

	it("notifies from the pane a terminal shows when a session stops working", async () => {
		const w = setup("pi-a", [{ session: "pi-a", termname: "xterm-ghostty" }]);
		w.set([session("x", "working"), session("y", "working")]);
		await w.tick();
		w.set([session("x", "done", "Fixed it"), session("y", "needs")]);
		await w.tick();
		expect(w.written).toEqual([
			notificationEscape("task x", "Done — Fixed it", "xterm-ghostty", true),
			notificationEscape("task y", "Needs input", "xterm-ghostty", true),
		]);
	});

	it("stays quiet in a pane no terminal shows, and asks tmux only when there is news", async () => {
		const w = setup("pi-a", [{ session: "pi-b", termname: "xterm-ghostty" }]);
		w.set([session("x", "working")]);
		await w.tick();
		await w.tick();
		expect(w.tmuxCalls()).toBe(0);
		w.set([session("x", "done")]);
		await w.tick();
		expect(w.tmuxCalls()).toBe(1);
		expect(w.written).toEqual([]);
	});

	it("survives a daemon or tmux that is not there", async () => {
		const tick = watchSessions({
			pane: "pi-a",
			sessions: async () => {
				throw new Error("no daemon");
			},
			clients: () => {
				throw new Error("no server");
			},
			write: () => {
				throw new Error("unreachable");
			},
		});
		await expect(tick()).resolves.toBeUndefined();
	});
});
