import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentActivity } from "../../daemon/activity.ts";
import type { SessionMessage, SessionUsage } from "../../daemon/ipc/protocol.ts";
import { OrchestratorClient } from "../../daemon/orchestrator-client.ts";
import { textOf } from "../../daemon/session-state.ts";
import { endPane, PARENT_ENV, RUN_DIR_ENV, RUN_TASK_ENV, Tmux } from "../../daemon/tmux.ts";
import { ForegroundActivity } from "../agent-view/self-registration.ts";
import { type RunReport, type RunReports, runTaskText, SUBAGENT_MESSAGE_CUSTOM_TYPE } from "./messages.ts";
import { fromRun } from "./run-messages.ts";
import {
	bestEffortAsync,
	formatRunLabel,
	handedOff,
	type SubagentRunExecuteParams,
	type SubagentRunOutcome,
	type SubagentRunRecord,
	tryTmux,
} from "./runs.ts";
import {
	newestRunSession,
	readRunReports,
	runDirParentSessionId,
	type StoredRunReport,
	storeRunReport,
} from "./storage.ts";
import { sessionUsage } from "./usage.ts";

export interface RunLaunch {
	runDir: string;
	sessionFile?: string;
	parent: string;
	pane: string;
}

export function legacyRunRefusal(
	run: Pick<SubagentRunRecord, "name" | "runId" | "reportPath" | "transcriptPath">,
): string {
	return `${formatRunLabel(run)} ran in tmux, before runs ran on pi's RPC, and is not resumed. To continue its work, launch a new subagent and point it at its Report (${run.reportPath ?? "none was stored"}) and transcript (${run.transcriptPath ?? "none was stored"}).`;
}

export function runSessionFile(run: Pick<RunLaunch, "runDir" | "sessionFile">): string | undefined {
	return run.sessionFile ?? newestRunSession(run.runDir);
}

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

const PANE_CHECK_MS = 2000;

export function paneUp(tmux: Pick<Tmux, "hasSession">, pane: string): boolean {
	return tryTmux(() => tmux.hasSession(pane)) ?? true;
}

const REGISTER_WAIT_MS = 10_000;

export const storedReport = (pane: string, stored: StoredRunReport): RunReport => ({
	type: "session_message",
	kind: "report",
	from: pane,
	...stored,
});

export interface TmuxRunDeps {
	tmux: Pick<Tmux, "hangUpAsQuit" | "hasSession" | "shown">;
	reports: RunReports;
	notify(report: RunReport): void;
	needsInput(dialog: string | undefined): void;
	usage(sessionId: string, totals: SessionUsage): void;
	handOff: AbortSignal;
}

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
		if (!fromDisk && message.seq !== undefined && message.seq > delivered + 1) pull();
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
	const pull = () => {
		for (const stored of readRunReports(launch.runDir, delivered)) receive(storedReport(pane, stored), true);
	};
	pull();
	let watch: ReturnType<typeof setInterval> | undefined;
	let wasHandedOff = false;
	let handOff = () => {};
	try {
		await new Promise<void>((resolve) => {
			if (signal.aborted) return resolve();
			signal.addEventListener("abort", () => resolve(), { once: true });
			handOff = () => {
				wasHandedOff = true;
				resolve();
			};
			deps.handOff.addEventListener("abort", handOff, { once: true });
			watch = setInterval(() => {
				if (paneUp(deps.tmux, pane)) return;
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
	if (wasHandedOff && !signal.aborted) return handedOff();
	await closeRun(deps.tmux, pane, launch.parent);
	return { status: "closed", summaryText: last, transcriptPath: runSessionFile(launch) };
}

async function closeRun(tmux: Pick<Tmux, "hangUpAsQuit" | "shown">, pane: string, from: string): Promise<void> {
	const shown = tryTmux(() => tmux.shown(pane));
	const closeSent =
		shown &&
		(await bestEffortAsync(() =>
			new OrchestratorClient().send(pane, { type: "session_message", kind: "close", from }),
		));
	if (closeSent) return;
	endPane(tmux, pane);
}

const LEAVE_CHECK_MS = 500;

export function actAsRun(pi: ExtensionAPI, parent: () => string, pane: string | undefined): { closed: () => boolean } {
	const runDir = process.env[RUN_DIR_ENV];
	const store = (report: Parameters<typeof storeRunReport>[1]) => {
		if (!runDir) return undefined;
		try {
			return storeRunReport(runDir, report);
		} catch {
			return undefined;
		}
	};
	const activity = new ForegroundActivity();
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
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		current?.abort();
		current?.ui.notify("Closed by its orchestrator. It ends once you leave it: ← goes back.", "info");
		if (!pane) return;
		const tmux = new Tmux(undefined, undefined, { timeoutMs: 2000 });
		const watch = setInterval(() => {
			if (tryTmux(() => tmux.shown(pane)) !== false) return;
			clearInterval(watch);
			endPane(tmux, pane);
		}, LEAVE_CHECK_MS);
	};
	pi.on("input", (event, ctx) => {
		if (!closed || event.text.trimStart().startsWith("/")) return { action: "continue" };
		ctx.ui.notify("This subagent is closed: ask its orchestrator to resume it.", "warning");
		return { action: "handled" };
	});
	pi.events.on("bluclawd:session-message", (data) => {
		const message = data as SessionMessage;
		if (message.kind === "stop" && message.from === parent()) current?.abort();
		if (message.kind === "close" && message.from === parent()) close();
		if (message.kind === "adopt" && runDir && runDirParentSessionId(runDir) === message.sessionId) {
			process.env[PARENT_ENV] = message.from;
			told = undefined;
			if (current) void tellActivity(current);
		}
	});
	pi.on("session_start", (_event, ctx) => {
		current = ctx;
		const taskFile = process.env[RUN_TASK_ENV];
		delete process.env[RUN_TASK_ENV];
		if (!taskFile) return;
		const task = readFileSync(taskFile, "utf8");
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
		pi.sendUserMessage(runTaskText(task, false));
	});
	pi.on("agent_start", (event, ctx) => {
		if (closed) return ctx.abort();
		void tell(event, ctx);
	});
	pi.on("turn_start", (event, ctx) => void tell(event, ctx));
	pi.on("ui_prompt_start", (event, ctx) => void tell(event, ctx));
	pi.on("ui_prompt_end", (event, ctx) => void tell(event, ctx));
	pi.on("agent_settled", (event, ctx) => {
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
		// Not awaited, as pi waits on this handler. The orchestrator reads a Report its retries never got through.
		sending = sending.then(() => send(parent, report, ctx, REPORT_RETRY_MS));
	});
	return { closed: () => closed };
}

const REPORT_RETRY_MS = [500, 1000, 2000, 4000, 8000, 15_000];

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
		// A replaced session's ctx throws.
		try {
			ctx.ui.notify(
				`${message.kind === "report" ? "Report" : "State"} not sent to the orchestrator: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		} catch {}
	}
}
