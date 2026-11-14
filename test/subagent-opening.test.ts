import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlotClaim } from "../daemon/run-queue.ts";
import type { AdmissionResult } from "../ext/subagents/admission.ts";
import { createRunOpening } from "../ext/subagents/opening.ts";
import type { SubagentRunRecord } from "../ext/subagents/runs.ts";
import { fakeScheduler, runRecord, SESSION } from "./helpers/fake-runs.ts";

afterEach(() => {
	vi.useRealTimers();
});

/** An orchestrator opening its runs, as `/tasks` and the panel do. */
function setup(
	runs: SubagentRunRecord[],
	options: {
		mode?: string;
		/** This pi's tmux session; none outside tmux. */
		pane?: string;
		/** Whether its runs run in panes of their own (ADR-0013). */
		panes?: boolean;
		/** The tmux sessions up. */
		up?: string[];
		/** What the user types when asked for an instruction. */
		typed?: string;
		daemon?: boolean;
		slot?: SlotClaim;
		resume?: (run: SubagentRunRecord) => AdmissionResult;
		/** Switching the terminal fails with this. */
		switchFails?: string;
	} = {},
) {
	const scheduler = fakeScheduler(runs);
	const notices: { text: string; level: string }[] = [];
	const entries: unknown[] = [];
	const switched: string[] = [];
	const asked: string[] = [];
	const instructed: string[] = [];
	const claimed: string[] = [];
	const released: string[] = [];
	const resumed: { runId: string; changes: unknown }[] = [];
	const up = new Set(options.up ?? []);
	const ctx = {
		mode: options.mode ?? "tui",
		ui: {
			notify: (text: string, level: string) => notices.push({ text, level }),
			input: async (title: string) => {
				asked.push(title);
				return options.typed;
			},
		},
	} as unknown as ExtensionContext;
	const open = createRunOpening({
		scope: { current: () => ({ parentSessionId: SESSION, sessionEpoch: 1 }), context: () => ctx },
		scheduler,
		admission: {
			resume: async (run, _prompt, _ctx, changes) => {
				resumed.push({ runId: run.runId, changes });
				return (options.resume?.(run) ?? {
					ok: true,
					handle: { runId: run.runId, record: { ...run, generation: run.generation + 1 } },
				}) as AdmissionResult;
			},
		},
		slots: {
			ensure: async () => options.daemon ?? true,
			claimNow: async (key) => {
				claimed.push(key);
				return options.slot ?? { granted: true, active: 1, capacity: 4 };
			},
			release: async (key) => {
				released.push(key);
			},
		},
		intervention: {
			conversation: (run) => [`conversation of ${run.runId}`],
			instruct: async (run, text) => {
				instructed.push(text);
				return { ok: true, text: `${run.name} takes your instruction.` };
			},
		},
		appendEntry: (_type, data) => entries.push(data),
		tmux: () => ({
			hasSessionAsync: async (name) => up.has(name),
			setOpenedFromView: () => {},
			switchTo: (name) => {
				if (options.switchFails) throw new Error(options.switchFails);
				switched.push(name);
			},
		}),
		// Each run's record says its kind: its run directory is never read.
		agentDir: () => "/no-agent-dir",
		pane: () => options.pane,
		runPane: () => (options.panes && options.pane ? options.pane : undefined),
	});
	return { open, scheduler, notices, entries, switched, asked, instructed, claimed, released, resumed, up };
}

const CONVERSATION = (runId: string) => [{ lines: [`conversation of ${runId}`] }];

describe("Opening a run", () => {
	it("does nothing outside the TUI", () => {
		const s = setup([runRecord({ name: "a" })], { mode: "print" });
		expect(s.open("sub_a")).toBeUndefined();
		expect(s.notices).toEqual([]);
	});

	it("refuses a run this session does not know, or that belongs to an earlier session", () => {
		const s = setup([runRecord({ name: "old", sessionEpoch: 0 }), runRecord({ name: "a" })]);
		expect(s.open("sub_none")).toBeUndefined();
		expect(s.open("sub_old")).toBeUndefined();
		expect(s.open("sub_a", "another-session")).toBeUndefined();
		expect(s.notices).toEqual([
			{ text: "No run sub_none is known to this session, so it cannot be opened.", level: "warning" },
			{ text: "That run belongs to an earlier session and can no longer be opened.", level: "warning" },
			{ text: "That run belongs to an earlier session and can no longer be opened.", level: "warning" },
		]);
	});

	describe("a Legacy run", () => {
		const legacy = (overrides: Partial<SubagentRunRecord> = {}) =>
			runRecord({ name: "old", backend: undefined, kind: undefined, pane: "pi-old", ...overrides });

		it("switches the terminal to its pane while it is open", async () => {
			const s = setup([legacy()]);
			await s.open("sub_old");
			expect(s.switched).toEqual(["pi-old"]);
		});

		it("says why when its pane cannot be shown", async () => {
			const s = setup([legacy()], { switchFails: "no client" });
			await s.open("sub_old");
			expect(s.notices).toEqual([{ text: `Could not open old: no client`, level: "warning" }]);
		});

		it("shows its conversation once it ended, and says it is not resumed", async () => {
			const s = setup([legacy({ status: "closed" })]);
			await s.open("sub_old");
			expect(s.switched).toEqual([]);
			expect(s.entries).toEqual(CONVERSATION("sub_old"));
			expect(s.notices[0]?.text).toMatch(
				/^"old" \(sub_old\) ran in tmux, before runs ran on pi's RPC, and is not resumed\./,
			);
		});
	});

	describe("from an orchestrator whose runs run in panes", () => {
		const options = { pane: "pi-orchestrator", panes: true } as const;

		it("switches the terminal to a working Pane run's pane", async () => {
			const s = setup([runRecord({ name: "a", kind: "pane", generation: 2 })], { ...options, up: ["sub_a-2"] });
			await s.open("sub_a");
			expect(s.switched).toEqual(["sub_a-2"]);
		});

		it("says a queued Pane run opens once it runs", async () => {
			const s = setup([runRecord({ name: "a", kind: "pane", status: "starting" })], options);
			await s.open("sub_a");
			expect(s.notices).toEqual([{ text: "a waits for its turn; open it again once it runs.", level: "info" }]);
		});

		it("shows a working run's conversation when it has no pane, and gives it the user's instruction", async () => {
			const s = setup([runRecord({ name: "a" })], { ...options, typed: " look again " });
			await s.open("sub_a");
			expect(s.entries).toEqual(CONVERSATION("sub_a"));
			expect(s.asked).toEqual(["Instruct a"]);
			expect(s.instructed).toEqual(["look again"]);
			expect(s.notices).toEqual([{ text: "a takes your instruction.", level: "info" }]);
		});

		it("resumes a finished run in a pane, in a slot free now, for the user to type in", async () => {
			const s = setup([runRecord({ name: "a", kind: "pane", status: "closed" })], { ...options, up: ["sub_a-1"] });
			await s.open("sub_a");
			expect(s.claimed).toEqual(["sub_a/1"]);
			expect(s.resumed).toEqual([{ runId: "sub_a", changes: { from: "user", typed: true } }]);
			expect(s.switched).toEqual(["sub_a-1"]);
		});

		it("starts nothing for a finished run with no slot free now, and says why", async () => {
			const s = setup([runRecord({ name: "a", status: "closed" })], {
				...options,
				slot: { granted: false, active: 2, capacity: 2 },
			});
			await s.open("sub_a");
			expect(s.resumed).toEqual([]);
			expect(s.notices).toEqual([
				{
					text: "No slot is free for a (2 of 2 runs active): nothing was started. Open it again once a run ends.",
					level: "info",
				},
			]);
		});

		it("says a finished run is opening already when another open claimed its slot", async () => {
			const s = setup([runRecord({ name: "a", status: "closed" })], {
				...options,
				slot: { granted: false, claimed: true, active: 1, capacity: 2 },
			});
			await s.open("sub_a");
			expect(s.resumed).toEqual([]);
			expect(s.notices).toEqual([{ text: "a is opening already: its pane shows once it starts.", level: "info" }]);
		});

		it("starts nothing without the daemon that queues runs", async () => {
			const s = setup([runRecord({ name: "a", status: "closed" })], { ...options, daemon: false });
			await s.open("sub_a");
			expect(s.claimed).toEqual([]);
			expect(s.notices).toEqual([
				{ text: "Could not open a: the daemon that queues runs is not running", level: "warning" },
			]);
		});

		it("gives back the slot of a Resume Admission refuses, and shows the run's conversation", async () => {
			const s = setup([runRecord({ name: "a", status: "cancelled" })], {
				...options,
				resume: () => ({ ok: false, error: "Cannot resume a: its worktree is gone." }),
			});
			await s.open("sub_a");
			expect(s.released).toEqual(["sub_a/1"]);
			expect(s.notices).toEqual([{ text: "Cannot resume a: its worktree is gone.", level: "warning" }]);
			expect(s.entries).toEqual(CONVERSATION("sub_a"));
		});

		it("says a Resume whose pane never showed was slow to start", async () => {
			vi.useFakeTimers();
			const s = setup([runRecord({ name: "a", status: "closed" })], options);
			const opened = s.open("sub_a");
			await vi.advanceTimersByTimeAsync(5200);
			await opened;
			expect(s.switched).toEqual([]);
			expect(s.notices).toEqual([
				{ text: "a was slow to start, and ends with nothing done; open it again.", level: "info" },
			]);
		});

		it("shows a queued RPC run's conversation, as its kind has it", async () => {
			const s = setup([runRecord({ name: "a", status: "starting" })], options);
			await s.open("sub_a");
			expect(s.entries).toEqual(CONVERSATION("sub_a"));
			expect(s.notices).toEqual([]);
		});

		it("shows the conversation of a finished run that cannot be resumed", async () => {
			const s = setup([runRecord({ name: "a", status: "failed" })], options);
			await s.open("sub_a");
			expect(s.claimed).toEqual([]);
			expect(s.entries).toEqual(CONVERSATION("sub_a"));
		});
	});

	describe("from an orchestrator whose runs run on pi's RPC", () => {
		it("switches the terminal to a working Pane run's pane, as its kind has it", async () => {
			const s = setup([runRecord({ name: "a", kind: "pane" })], { pane: "pi-orchestrator", up: ["sub_a-0"] });
			await s.open("sub_a");
			expect(s.switched).toEqual(["sub_a-0"]);
			expect(s.entries).toEqual([]);
		});

		it("says a queued Pane run opens once it runs, as its kind has it", async () => {
			const s = setup([runRecord({ name: "a", kind: "pane", status: "starting" })], { pane: "pi-orchestrator" });
			await s.open("sub_a");
			expect(s.entries).toEqual([]);
			expect(s.notices).toEqual([{ text: "a waits for its turn; open it again once it runs.", level: "info" }]);
		});

		it("switches the terminal to a finished Pane run's pane while it is still up", async () => {
			const s = setup([runRecord({ name: "a", kind: "pane", status: "closed" })], {
				pane: "pi-orchestrator",
				up: ["sub_a-0"],
			});
			await s.open("sub_a");
			expect(s.switched).toEqual(["sub_a-0"]);
			expect(s.entries).toEqual([]);
		});

		it("shows a working Pane run's conversation from a terminal outside tmux", async () => {
			const s = setup([runRecord({ name: "a", kind: "pane" })], { up: ["sub_a-0"] });
			await s.open("sub_a");
			expect(s.switched).toEqual([]);
			expect(s.entries).toEqual(CONVERSATION("sub_a"));
		});

		it("shows a finished run's conversation, and resumes it with the user's instruction", async () => {
			const s = setup([runRecord({ name: "a", status: "closed" })], { typed: "go on" });
			await s.open("sub_a");
			expect(s.claimed).toEqual([]);
			expect(s.entries).toEqual(CONVERSATION("sub_a"));
			expect(s.instructed).toEqual(["go on"]);
		});

		it("only shows a run's conversation when the user types nothing", async () => {
			const s = setup([runRecord({ name: "a" })]);
			await s.open("sub_a");
			expect(s.entries).toEqual(CONVERSATION("sub_a"));
			expect(s.instructed).toEqual([]);
			expect(s.notices).toEqual([]);
		});
	});
});
