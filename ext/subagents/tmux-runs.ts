/**
 * Runs in tmux, from before runs ran on pi's RPC (ADR-0006, ADR-0010): such a run is an interactive pi in agent
 * view's private tmux server. None starts any more; one still open when its orchestrator takes the new runtime is
 * followed until it ends or is stopped. Its bluclawd knows it is a run by PARENT_ENV, and reports to its orchestrator
 * through the daemon each time it settles; each Report goes to the orchestrator as a notice that wakes it.
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentActivity } from "../../daemon/activity.ts";
import type { SessionMessage, SessionUsage } from "../../daemon/ipc/protocol.ts";
import { OrchestratorClient } from "../../daemon/orchestrator-client.ts";
import { textOf } from "../../daemon/session-state.ts";
import { endPane, PARENT_ENV, RUN_DIR_ENV, RUN_TASK_ENV, Tmux } from "../../daemon/tmux.ts";
import { ForegroundActivity } from "../agent-view/self-registration.ts";
import { SUBAGENT_MESSAGE_CUSTOM_TYPE } from "./messages.ts";
import { fromRun, runTaskText } from "./run-messages.ts";
import type { SubagentRunExecuteParams, SubagentRunOutcome } from "./runs.ts";
import {
	newestRunSession,
	readRunReports,
	runDirParentSessionId,
	type StoredRunReport,
	storeRunReport,
} from "./storage.ts";
import { sessionUsage } from "./usage.ts";

/** A run in tmux its orchestrator follows: where it is, and where it keeps its session and Reports. */
export interface RunLaunch {
	/** Where its session and Reports are kept. */
	runDir: string;
	/** The session a Resume reopened, before runs ran on pi's RPC; else its newest in `runDir`. */
	sessionFile?: string;
	/** The orchestrator's tmux session. */
	parent: string;
	/** The pane its pi runs in, which its orchestrator takes over. */
	pane: string;
}

/** The run's session file: the one a Resume reopened, else the newest pi wrote in its directory. */
export function runSessionFile(run: Pick<RunLaunch, "runDir" | "sessionFile">): string | undefined {
	return run.sessionFile ?? newestRunSession(run.runDir);
}

/**
 * Sends a run's pi a message through the daemon. A run just launched registers with the daemon a moment after its
 * pi starts, so a pane the daemon does not know yet is tried again for a while.
 */
export async function sendToRun(
	send: (pane: string, message: SessionMessage) => Promise<void>,
	pane: string,
	message: SessionMessage,
	signal?: AbortSignal,
): Promise<void> {
	const deadline = Date.now() + REGISTER_WAIT_MS;
	for (;;) {
		try {
			return await send(pane, message);
		} catch (error) {
			const starting = String(error).includes("Unknown instance") && Date.now() < deadline && !signal?.aborted;
			if (!starting) throw error;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	}
}

/** How often an open run's pane is checked for a pi that exited by itself. */
const PANE_CHECK_MS = 2000;

/** Whether the run's pane is still there; when tmux cannot say, it is taken to be. */
export function paneUp(tmux: Pick<Tmux, "hasSession">, pane: string): boolean {
	try {
		return tmux.hasSession(pane);
	} catch {
		return true;
	}
}

/** How long a send waits for a run's pi to register: past one heartbeat that timed out, and the next. */
const REGISTER_WAIT_MS = 10_000;

type RunReport = Extract<SessionMessage, { kind: "report" }>;

/** A Report its run stored, as it would have come from its pane. */
export const storedReport = (pane: string, stored: StoredRunReport): RunReport => ({
	type: "session_message",
	kind: "report",
	from: pane,
	...stored,
});

/** Where the Reports of the orchestrator's runs go: to the foreground launch waiting for one, else to the run. */
export class RunReports {
	/** Each open run's message handler, by its tmux session. */
	private readonly runs = new Map<string, (message: SessionMessage) => void>();
	/** Foreground launches waiting for a run's next Report, by run ID. */
	private readonly waiting = new Map<string, (report: RunReport | undefined) => void>();

	/** Hands the messages from `pane` to `onMessage` until the returned function is called. */
	listen(pane: string, onMessage: (message: SessionMessage) => void): () => void {
		this.runs.set(pane, onMessage);
		return () => {
			if (this.runs.get(pane) === onMessage) this.runs.delete(pane);
		};
	}

	/** The run's next Report; undefined once `signal` aborts first. */
	next(runId: string, signal?: AbortSignal): Promise<RunReport | undefined> {
		return new Promise((resolve) => {
			const done = (report: RunReport | undefined) => {
				this.waiting.delete(runId);
				signal?.removeEventListener("abort", aborted);
				resolve(report);
			};
			const aborted = () => done(undefined);
			if (signal?.aborted) return done(undefined);
			signal?.addEventListener("abort", aborted, { once: true });
			this.waiting.set(runId, done);
		});
	}

	/** Whether a call waits for the run's next Report: it is told of the run's end as well. */
	awaited(runId: string): boolean {
		return this.waiting.has(runId);
	}

	/** Gives a run's Report to the launch waiting for it; false when none waits. */
	take(runId: string, report: RunReport): boolean {
		const waiter = this.waiting.get(runId);
		waiter?.(report);
		return waiter !== undefined;
	}

	/** A Report or state from another session; false when it is neither, or from no open run. */
	receive(message: SessionMessage): boolean {
		const run = message.kind === "report" || message.kind === "activity" ? this.runs.get(message.from) : undefined;
		run?.(message);
		return run !== undefined;
	}
}

export interface TmuxRunDeps {
	tmux: Pick<Tmux, "end" | "hasSession" | "shown">;
	reports: RunReports;
	/** A Report no foreground launch took: it goes to the orchestrator. */
	notify(report: RunReport): void;
	/** The run started waiting on a prompt in its own session: the user is told in the orchestrator's. */
	needsInput(dialog: string | undefined): void;
	/** The usage so far of the run's session `sessionId`, from its latest Report. */
	usage(sessionId: string, totals: SessionUsage): void;
	/** Aborted when this orchestrator hands its open runs over to the next instance of its session (a reload). */
	handOff: AbortSignal;
}

/**
 * A run's life in its own pi, as the scheduler sees it: it routes each Report until the run is closed. It stays open
 * between Reports, so only a stop ends it: its pi is hung up, as quitting does, without asking it, and its session is
 * kept.
 */
export async function executeTmuxRun(
	{ record, signal, controller }: SubagentRunExecuteParams,
	launch: RunLaunch,
	deps: TmuxRunDeps,
): Promise<SubagentRunOutcome> {
	const { pane } = launch;
	controller.recordPane(pane);
	controller.markRunning();
	let last = "";
	let delivered = record.lastDeliveredSeq ?? 0;
	const receive = (message: SessionMessage, fromDisk = false) => {
		if (message.kind === "activity") {
			controller.updateActivity(message.activity);
			if (message.activity === "awaiting_input") deps.needsInput(message.dialog);
			return;
		}
		if (message.kind !== "report") return;
		// Those before it that never came go first: the daemon may have lost them with no failed send to tell.
		if (!fromDisk && message.seq !== undefined && message.seq > delivered + 1) pull();
		// A Report sent again after a retry, or read from disk after it came, is told once.
		if (message.seq !== undefined) {
			if (message.seq <= delivered) return;
			delivered = message.seq;
			controller.markDelivered(delivered);
		}
		last = message.text;
		if (message.usage) {
			controller.updateUsage(message.usage);
			deps.usage(message.sessionId ?? record.runId, message.usage);
		}
		controller.updateProgress(message.text);
		if (!deps.reports.take(record.runId, message)) deps.notify(message);
	};
	const unlisten = deps.reports.listen(pane, receive);
	/** The Reports the run stored that never came: its sends failed. */
	const pull = () => {
		for (const stored of readRunReports(launch.runDir, delivered)) receive(storedReport(pane, stored), true);
	};
	// Taken over after a reload: what it stored while no instance listened.
	pull();
	// Closed by its orchestrator, or its own pi exited (quit, crash): its session is kept either way.
	let watch: ReturnType<typeof setInterval> | undefined;
	let handedOff = false;
	let handOff = () => {};
	try {
		await new Promise<void>((resolve) => {
			if (signal.aborted) return resolve();
			signal.addEventListener("abort", () => resolve(), { once: true });
			handOff = () => {
				handedOff = true;
				resolve();
			};
			deps.handOff.addEventListener("abort", handOff, { once: true });
			watch = setInterval(() => {
				if (paneUp(deps.tmux, pane)) return;
				// A foreground launch may still wait on a Report its run could not send.
				pull();
				resolve();
			}, PANE_CHECK_MS);
			watch.unref?.();
		});
	} finally {
		clearInterval(watch);
		deps.handOff.removeEventListener("abort", handOff);
		unlisten();
	}
	// The next instance of the orchestrator's session goes on with the run, from its stored record: this one never
	// settles it, so it stores nothing more.
	if (handedOff && !signal.aborted) return new Promise<never>(() => {});
	await closeRun(deps.tmux, pane, launch.parent);
	return { status: "closed", summaryText: last, transcriptPath: runSessionFile(launch) };
}

/**
 * Ends a closed run's pi. One a terminal shows is only told it is closed, so the user is not thrown out of it: it
 * ends itself once the terminal leaves it (actAsRun). Should it not hear, it ends at once.
 */
async function closeRun(tmux: Pick<Tmux, "end" | "shown">, pane: string, from: string): Promise<void> {
	let shown = false;
	try {
		shown = tmux.shown(pane);
	} catch {
		// Gone, or tmux did not answer: ended as before.
	}
	if (shown) {
		try {
			await new OrchestratorClient().send(pane, { type: "session_message", kind: "close", from });
			return;
		} catch {
			// Not reached: ended at once.
		}
	}
	endPane(tmux, pane);
}

/** How often a closed run checks whether a terminal still shows it. */
const LEAVE_CHECK_MS = 500;

/**
 * Inside a run: its task is its first prompt, it tells its orchestrator whenever it starts working, falls
 * idle or waits on a prompt of its own, and each time it settles its last message goes to its orchestrator
 * as a Report. Its orchestrator, `parent()`, is the pane of the session that took it over last (ADR-0008).
 */
export function actAsRun(pi: ExtensionAPI, parent: () => string, pane: string | undefined): { closed: () => boolean } {
	const runDir = process.env[RUN_DIR_ENV];
	/** Stores a Report before it is sent, numbered; none from a run started before Reports were stored. */
	const store = (report: Parameters<typeof storeRunReport>[1]) => {
		if (!runDir) return undefined;
		try {
			return storeRunReport(runDir, report);
		} catch {
			return undefined;
		}
	};
	const activity = new ForegroundActivity();
	/** What the orchestrator was last told. States and Reports go out one after another, in order. */
	let told: AgentActivity | undefined;
	let sending = Promise.resolve();
	const tell = (event: { type: string; kind?: string; title?: string }, ctx: ExtensionContext) => {
		activity.apply(event);
		return tellActivity(ctx);
	};
	const tellActivity = (ctx: ExtensionContext) => {
		const now = activity.current;
		if (!pane || closed || now === told) return sending;
		told = now;
		const message: SessionMessage = {
			...fromRun(pi, pane),
			kind: "activity",
			activity: now,
			...(now === "awaiting_input" && activity.dialog?.title ? { dialog: activity.dialog.title } : {}),
		};
		sending = sending.then(() => send(parent, message, ctx));
		return sending;
	};

	let current: ExtensionContext | undefined;
	/** Closed by its orchestrator while a terminal showed it: it takes nothing more, and ends once the terminal leaves. */
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		current?.abort();
		current?.ui.notify("Closed by its orchestrator. It ends once you leave it: ← goes back.", "info");
		if (!pane) return;
		const tmux = new Tmux(undefined, undefined, { timeoutMs: 2000 });
		const watch = setInterval(() => {
			try {
				if (tmux.shown(pane)) return;
			} catch {
				// tmux did not answer: checked again next time.
				return;
			}
			clearInterval(watch);
			endPane(tmux, pane);
		}, LEAVE_CHECK_MS);
	};
	pi.on("input", (event, ctx) => {
		// Its own commands still run: /quit, agent view.
		if (!closed || event.text.trimStart().startsWith("/")) return { action: "continue" };
		ctx.ui.notify("This subagent is closed: ask its orchestrator to resume it.", "warning");
		return { action: "handled" };
	});
	pi.events.on("bluclawd:session-message", (data) => {
		const message = data as SessionMessage;
		// Only its orchestrator stops its turn.
		if (message.kind === "stop" && message.from === parent()) current?.abort();
		if (message.kind === "close" && message.from === parent()) close();
		// Its orchestrator's session, reopened in another pane: its run directory is kept under that session's.
		if (message.kind === "adopt" && runDir && runDirParentSessionId(runDir) === message.sessionId) {
			process.env[PARENT_ENV] = message.from;
			// The adopting session lists the run as it was stored: it is told what the run does now.
			told = undefined;
			if (current) void tellActivity(current);
		}
	});
	pi.on("session_start", (_event, ctx) => {
		current = ctx;
		const taskFile = process.env[RUN_TASK_ENV];
		// Read once: a reload or a later session of this pi must not send it again.
		delete process.env[RUN_TASK_ENV];
		if (!taskFile) return;
		const task = readFileSync(taskFile, "utf8");
		// A session with messages already is a Resume: its task comes as a message from its orchestrator.
		if (ctx.sessionManager.getBranch().some((entry) => entry.type === "message")) {
			pi.sendMessage(
				{
					customType: SUBAGENT_MESSAGE_CUSTOM_TYPE,
					content: [{ type: "text", text: runTaskText(task, true) }],
					display: true,
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
			return;
		}
		// A new session's first turn must be a prompt: pi builds the system prompt only there, and a custom
		// message that starts the turn goes without it. The frame still says it is not from the user.
		pi.sendUserMessage(runTaskText(task, false));
	});
	pi.on("agent_start", (event, ctx) => {
		// Closed, it runs no turn, whatever starts one (a skill, a prompt template): nobody would hear its Report.
		if (closed) return ctx.abort();
		void tell(event, ctx);
	});
	pi.on("turn_start", (event, ctx) => void tell(event, ctx));
	pi.on("ui_prompt_start", (event, ctx) => void tell(event, ctx));
	pi.on("ui_prompt_end", (event, ctx) => void tell(event, ctx));
	pi.on("agent_settled", (event, ctx) => {
		// Idle before the Report, so the orchestrator it wakes no longer waits for this run: in the order sent, not
		// awaited, as pi waits on this handler and an earlier Report may still be retrying.
		void tell(event, ctx);
		if (!pane || closed) return;
		const last = [...ctx.sessionManager.getBranch()]
			.reverse()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		const text = last?.type === "message" && "content" in last.message ? textOf(last.message.content) : "";
		const content = {
			text,
			usage: sessionUsage(ctx.sessionManager.getEntries()),
			sessionId: ctx.sessionManager.getSessionId(),
		};
		const report: SessionMessage = { ...fromRun(pi, pane), kind: "report", ...content, seq: store(content) };
		// Not awaited, as pi waits on this handler: the orchestrator reads a Report its retries never got through.
		// Each try goes to its orchestrator as of then: one that takes the run over meanwhile gets it.
		sending = sending.then(() => send(parent, report, ctx, REPORT_RETRY_MS));
	});
	return { closed: () => closed };
}

/** How long a run waits before each next try of a Report the daemon did not take: some 30s in all. */
const REPORT_RETRY_MS = [500, 1000, 2000, 4000, 8000, 15_000];

/** Sends, and again after each of `delays` while it fails; throws the last failure once they run out. */
export async function sendRetrying(send: () => Promise<void>, delays: readonly number[]): Promise<void> {
	for (const delay of delays) {
		try {
			return await send();
		} catch {
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
	return send();
}

async function send(
	parent: () => string,
	message: SessionMessage,
	ctx: ExtensionContext,
	retries: readonly number[] = [],
): Promise<void> {
	try {
		await sendRetrying(() => new OrchestratorClient().send(parent(), message), retries);
	} catch (error) {
		// A replaced session's ctx throws, which must not break the chain of later sends.
		try {
			ctx.ui.notify(
				`${message.kind === "report" ? "Report" : "State"} not sent to the orchestrator: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		} catch {}
	}
}
