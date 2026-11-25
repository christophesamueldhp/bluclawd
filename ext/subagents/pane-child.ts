import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PARENT_ENV, RUN_HOST_ENV, RUN_PANE_ENV, Tmux } from "../../daemon/tmux.ts";
import { BLOCKING_PROMPT_KINDS } from "../agent-view/self-registration.ts";
import { promptsFirst, startGeneration } from "./generation-protocol.ts";
import { claimGeneration, type HostSeat } from "./generation-state.ts";
import { noteRunError, ORCHESTRATOR_ABSENT_AFTER_MS, PANE_ENDED } from "./rpc-host.ts";
import { paneApprovalsUnanswerable } from "./run-approvals.ts";
import { bestEffort, tryTmux } from "./runs.ts";

const SHOWN_CHECK_MS = 500;
const OPEN_GRACE_MS = 2000;

function seatOf(runDir: string): HostSeat | string {
	const host = Number(process.env[RUN_HOST_ENV]);
	if (!Number.isInteger(host) || host <= 0) return "its host gave it no pid";
	try {
		const seat = claimGeneration(runDir, host);
		if (!seat) return `its host, pid ${host}, holds none of ${runDir}`;
		return seat.spec.pane ? seat : `the one its host holds in ${runDir} runs on pi's RPC`;
	} catch (error) {
		return `its spec in ${runDir} cannot be read: ${error instanceof Error ? error.message : String(error)}`;
	}
}

function noGeneration(pi: ExtensionAPI, runDir: string, why: string): void {
	const text = `it found no Generation of its own (${why})`;
	bestEffort(() => noteRunError(runDir, text));
	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.notify(text, "error");
		ctx.shutdown();
	});
}

export default function paneChild(pi: ExtensionAPI): void {
	const runDir = process.env[RUN_PANE_ENV];
	if (!runDir) return;
	const seat = seatOf(runDir);
	if (typeof seat === "string") {
		noGeneration(pi, runDir, seat);
		return;
	}
	const pane = seat.spec.pane;
	if (!pane) return;
	const { spec } = seat;
	let awaiting = false;
	const socket = process.env.TMUX?.split(",")[0];
	const tmux = socket ? new Tmux(dirname(socket), undefined, { timeoutMs: 2000 }) : undefined;

	let ctx: ExtensionContext | undefined;
	let done = false;
	let shuttingDown = false;
	let working = promptsFirst(spec);
	let held = false;
	let shown = false;
	const openedAt = Date.now();
	let checks: ReturnType<typeof setInterval> | undefined;

	const work = startGeneration({
		runDir,
		spec,
		link: {
			give: async (text) => {
				if (!ctx) return {};
				try {
					pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "steer" });
				} catch {
					return {};
				}
				working = true;
				held = false;
				return true;
			},
			quiet: async () => ctx?.isIdle() === true && !ctx.hasPendingMessages(),
			availableModels: async () => ctx?.modelRegistry.getAvailable() ?? [],
		},
		save: seat.saveChild,
		ended: () => {
			done = true;
			clearInterval(checks);
			awaiting = false;
			seat.saveChild({ awaiting });
			if (!shuttingDown) ctx?.shutdown();
		},
	});

	const isShown = () => tryTmux(() => tmux?.shown(pane.session));

	let parent = pane.parent;
	const followParent = () => {
		parent = seat.paneParent() ?? pane.parent;
		process.env[PARENT_ENV] = parent;
	};

	let unanswerable = new AbortController();
	paneApprovalsUnanswerable.set(unanswerable.signal);
	let orphanedSince: number | undefined;
	const checkOrphaned = () => {
		if (done || !awaiting) {
			orphanedSince = undefined;
			return;
		}
		const parentGone = tryTmux(() => tmux?.hasSession(parent)) === false;
		if (!parentGone || isShown() !== false) {
			orphanedSince = undefined;
			return;
		}
		orphanedSince ??= Date.now();
		if (Date.now() - orphanedSince < ORCHESTRATOR_ABSENT_AFTER_MS) return;
		orphanedSince = undefined;
		unanswerable.abort();
		unanswerable = new AbortController();
		paneApprovalsUnanswerable.set(unanswerable.signal);
	};

	const checkLeft = () => {
		if (done || (working && !held)) return;
		const now = isShown();
		if (now) shown = true;
		const left = now === false && (shown || (!working && Date.now() - openedAt > OPEN_GRACE_MS));
		if (left) work.end(working ? { status: "stopped", error: "the user stopped its work in its pane" } : undefined);
	};

	pi.on("session_start", (event, started) => {
		ctx = started;
		if (event.reason !== "startup") return;
		checks = setInterval(() => {
			followParent();
			checkLeft();
			checkOrphaned();
		}, SHOWN_CHECK_MS);
		void work.started({
			sessionFile: started.sessionManager.getSessionFile(),
			sessionId: started.sessionManager.getSessionId(),
			model: started.model,
			thinkingLevel: pi.getThinkingLevel(),
		});
	});

	const keep = () => {
		ctx?.ui.notify("This is a subagent's session: it stays on it. Ask its orchestrator for another.", "warning");
		return { cancel: true };
	};
	pi.on("session_before_switch", keep);
	pi.on("session_before_fork", keep);

	pi.on("input", (event) => {
		if (event.source === "interactive") {
			working = true;
			held = false;
			work.send({ kind: "typed", text: event.text });
		}
		return { action: "continue" };
	});

	pi.on("message_end", (event) => work.messageEnded(event.message));
	pi.on("tool_execution_end", (event) => work.toolEnded(event));

	pi.on("agent_settled", (event, settled) => {
		ctx = settled;
		if (done) return;
		if (event.aborted) {
			held = shown = true;
			return;
		}
		void work.settled();
	});

	pi.on("ui_prompt_start", (event) => {
		if (!BLOCKING_PROMPT_KINDS.has(event.kind)) return;
		awaiting = true;
		seat.saveChild({ awaiting });
	});
	pi.on("ui_prompt_end", (event) => {
		if (!BLOCKING_PROMPT_KINDS.has(event.kind)) return;
		awaiting = false;
		seat.saveChild({ awaiting });
	});

	// Heard before pi's shutdown on it reaches session_shutdown. pi hears it once its pane is ended from outside.
	let paneEnded = false;
	process.on("SIGHUP", () => {
		paneEnded = true;
	});
	pi.on("session_shutdown", () => {
		shuttingDown = true;
		work.end(working ? { status: "stopped", error: paneEnded ? PANE_ENDED : "its work was stopped" } : undefined);
	});
}
