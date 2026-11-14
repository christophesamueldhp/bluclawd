import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runPaneSession, runQueueKey, type SlotClaim } from "../../daemon/run-queue.ts";
import { Tmux } from "../../daemon/tmux.ts";
import type { RunAdmission } from "./admission.ts";
import { inParentScope, type ParentScope } from "./parent-scope.ts";
import { type RunSlots, runKind } from "./rpc-runs.ts";
import { type createRunIntervention, RUN_CONVERSATION_ENTRY } from "./run-intervention.ts";
import {
	isLegacyRun,
	isResumableSubagentStatus,
	isTerminalSubagentStatus,
	type SubagentRunRecord,
	type SubagentRunScheduler,
} from "./runs.ts";
import { subagentRunDir } from "./storage.ts";
import { legacyRunRefusal } from "./tmux-runs.ts";

/** How long opening a finished run waits for the pane its Resume runs in, in the slot it took. */
const PANE_OPEN_WAIT_MS = 5000;

export interface RunOpeningDeps {
	scope: { current(): ParentScope | undefined; context(): ExtensionContext | undefined };
	scheduler: Pick<SubagentRunScheduler, "getRun">;
	admission: Pick<RunAdmission, "resume">;
	/** The daemon's queue, where a Resume in a pane takes a slot free now. */
	slots: Pick<RunSlots, "ensure" | "claimNow" | "release">;
	intervention: Pick<ReturnType<typeof createRunIntervention>, "conversation" | "instruct">;
	appendEntry: ExtensionAPI["appendEntry"];
	tmux: () => Pick<Tmux, "hasSessionAsync" | "setOpenedFromView" | "switchTo">;
	agentDir: () => string;
	/** This pi's tmux session; none outside tmux. */
	pane: () => string | undefined;
	/** The orchestrator's tmux session when its runs run in panes of their own (ADR-0013). */
	runPane: () => string | undefined;
}

/**
 * Opens a run of the current parent scope, as `/tasks` and the panel do: settles once it has shown the run, or said why
 * it cannot. Nothing outside the TUI, nor for a run it refuses at once.
 */
export function createRunOpening(deps: RunOpeningDeps): (runId: string, owner?: string) => Promise<void> | undefined {
	const { scope, scheduler, admission, slots, intervention, runPane } = deps;

	/** Switches this terminal to a run's pane; opened from here, its ← comes back here, not to agent view. */
	const showRun = (name: string): void => {
		const tmux = deps.tmux();
		try {
			tmux.setOpenedFromView(name, false);
		} catch {
			// Its ← may then go to agent view.
		}
		tmux.switchTo(name);
	};

	/**
	 * Opens a run of the current parent scope: one on pi's RPC shows its conversation and takes an instruction; one in
	 * tmux from before switches this terminal to its pane while it is open (ADR-0006), else shows its conversation
	 * only. Any other run is refused with a notice.
	 */
	const openRun = (runId: string, owner?: string): Promise<void> | undefined => {
		const ctx = scope.context();
		if (ctx?.mode !== "tui") return undefined;
		const current = scope.current();
		const run = scheduler.getRun(runId);
		if (!run) {
			ctx.ui.notify(`No run ${runId} is known to this session, so it cannot be opened.`, "warning");
			return undefined;
		}
		if (!current || !inParentScope(run, current) || (owner !== undefined && owner !== run.parentSessionId)) {
			ctx.ui.notify("That run belongs to an earlier session and can no longer be opened.", "warning");
			return undefined;
		}
		if (!isLegacyRun(run)) return openGeneration(run, ctx);
		// A run in tmux from before runs ran on pi's RPC: its pane while it is open, else its history only.
		if (!run.pane || isTerminalSubagentStatus(run.status)) {
			deps.appendEntry(RUN_CONVERSATION_ENTRY, { lines: intervention.conversation(run) });
			ctx.ui.notify(legacyRunRefusal(run), "info");
			return Promise.resolve();
		}
		try {
			showRun(run.pane);
		} catch (error) {
			ctx.ui.notify(`Could not open ${run.name ?? runId}: ${Tmux.reason(error)}`, "warning");
		}
		return Promise.resolve();
	};

	/**
	 * Opens a run as the kind of its latest generation has it (GLOSSARY): a Pane run's pane while it is up, an RPC run's
	 * conversation; a queued Pane run opens once it runs. Only a Resume of a finished run decides anew, from where the
	 * orchestrator is now: in a pane for the user to type in when its runs run in panes, with a slot free for it now
	 * (ADR-0013), else with the instruction the user gives here.
	 */
	const openGeneration = async (run: SubagentRunRecord, ctx: ExtensionContext): Promise<void> => {
		const label = run.name ?? run.runId;
		const tmux = deps.tmux();
		const show = async (generation: number) => {
			const name = runPaneSession(run.runId, generation);
			if (!(await tmux.hasSessionAsync(name).catch(() => false))) return false;
			try {
				showRun(name);
			} catch (error) {
				ctx.ui.notify(`Could not open ${label}: ${Tmux.reason(error)}`, "warning");
			}
			return true;
		};
		// Only a terminal in tmux can be switched to a pane.
		const inPane =
			deps.pane() !== undefined &&
			runKind(run, subagentRunDir(deps.agentDir(), run.parentSessionId, run.runId)) === "pane";
		if (inPane && (await show(run.generation))) return;
		if (!isTerminalSubagentStatus(run.status)) {
			if (inPane && run.status === "starting")
				ctx.ui.notify(`${label} waits for its turn; open it again once it runs.`, "info");
			else await openRpcRun(run, ctx);
			return;
		}
		if (!runPane() || !isResumableSubagentStatus(run.status)) return openRpcRun(run, ctx);
		// No terminal would show a Resume that started later, after a wait in the queue: it takes a slot free now,
		// or starts nothing (#353).
		const key = runQueueKey(run.runId, run.generation + 1);
		let slot: SlotClaim;
		try {
			if (!(await slots.ensure())) throw new Error("the daemon that queues runs is not running");
			slot = await slots.claimNow(key, run.parentSessionId);
		} catch (error) {
			ctx.ui.notify(`Could not open ${label}: ${error instanceof Error ? error.message : String(error)}`, "warning");
			return;
		}
		if (slot.claimed) {
			ctx.ui.notify(`${label} is opening already: its pane shows once it starts.`, "info");
			return;
		}
		if (!slot.granted) {
			ctx.ui.notify(
				`No slot is free for ${label} (${slot.active} of ${slot.capacity} runs active): nothing was started. Open it again once a run ends.`,
				"info",
			);
			return;
		}
		const resumed = await admission.resume(run, () => "", ctx, { from: "user", typed: true });
		if (!resumed.ok) {
			slots.release(key).catch(() => {});
			ctx.ui.notify(resumed.error, "warning");
			// It cannot resume now: its conversation shows here instead, as for a run with no pane.
			return openRpcRun(run, ctx);
		}
		const generation = resumed.handle.record.generation;
		for (const until = Date.now() + PANE_OPEN_WAIT_MS; Date.now() < until; ) {
			if (await show(generation)) return;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		ctx.ui.notify(`${label} was slow to start, and ends with nothing done; open it again.`, "info");
	};

	/**
	 * A run on pi's RPC has no pane: opening it shows the user its conversation here, and asks for an instruction,
	 * which it takes at its next safe point, or resumes with once finished. Esc only looks.
	 */
	const openRpcRun = async (run: SubagentRunRecord, ctx: ExtensionContext): Promise<void> => {
		deps.appendEntry(RUN_CONVERSATION_ENTRY, { lines: intervention.conversation(run) });
		const text = (
			await ctx.ui.input(`Instruct ${run.name ?? run.runId}`, "An instruction for it; Esc only looks")
		)?.trim();
		if (!text) return;
		const result = await intervention.instruct(run, text, ctx);
		if (result.ok) ctx.ui.notify(result.text, "info");
		else ctx.ui.notify(result.error, "warning");
	};

	return openRun;
}
