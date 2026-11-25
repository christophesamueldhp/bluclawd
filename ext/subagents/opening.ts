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
	tryTmux,
} from "./runs.ts";
import { subagentRunDir } from "./storage.ts";
import { legacyRunRefusal } from "./tmux-runs.ts";

const PANE_OPEN_WAIT_MS = 5000;

export interface RunOpeningDeps {
	scope: { current(): ParentScope | undefined; context(): ExtensionContext | undefined };
	scheduler: Pick<SubagentRunScheduler, "getRun">;
	admission: Pick<RunAdmission, "resume">;
	slots: Pick<RunSlots, "ensure" | "claimNow" | "release">;
	intervention: Pick<ReturnType<typeof createRunIntervention>, "conversation" | "instruct">;
	appendEntry: ExtensionAPI["appendEntry"];
	tmux: () => Pick<Tmux, "hasSessionAsync" | "setOpenedFromView" | "switchTo">;
	agentDir: () => string;
	pane: () => string | undefined;
	runPane: () => string | undefined;
}

export function createRunOpening(deps: RunOpeningDeps): (runId: string, owner?: string) => Promise<void> | undefined {
	const { scope, scheduler, admission, slots, intervention, runPane } = deps;

	const showRun = (name: string): void => {
		const tmux = deps.tmux();
		tryTmux(() => tmux.setOpenedFromView(name, false));
		tmux.switchTo(name);
	};

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
		const resumed = await admission.resume(run, { typed: true }, ctx);
		if (!resumed.ok) {
			slots.release(key).catch(() => {});
			ctx.ui.notify(resumed.error, "warning");
			return openRpcRun(run, ctx);
		}
		const generation = resumed.handle.record.generation;
		for (const until = Date.now() + PANE_OPEN_WAIT_MS; Date.now() < until; ) {
			if (await show(generation)) return;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		ctx.ui.notify(`${label} was slow to start, and ends with nothing done; open it again.`, "info");
	};

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
