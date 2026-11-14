/**
 * Inside a run's pi in a pane (ADR-0013), what its host does over pi's RPC (rpc-host.ts): it gives the pi its task and
 * the messages posted to it, passes on what it sends and each prompt the user types in it, for its orchestrator, and
 * stores its Report once its work settles with nothing pending, then ends the pi. The user watches and may type
 * meanwhile; work they stop with Esc, and a Resume they opened to type in, wait for them, and end once they leave the
 * pane. An approval waits for the user too, unless its orchestrator is gone and no one watches the pane: then it is
 * blocked. The host takes what this stores once the pi exits.
 */

import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PARENT_ENV, RUN_PANE_ENV, Tmux } from "../../daemon/tmux.ts";
import { BLOCKING_PROMPT_KINDS } from "../agent-view/self-registration.ts";
import { startGeneration } from "./generation-protocol.ts";
import { type HostSeat, hostGeneration } from "./generation-state.ts";
import { PANE_ENDED } from "./rpc-host.ts";
import { paneApprovalsUnanswerable } from "./run-approvals.ts";

/** How often it looks whether a terminal still shows the pane. */
const SHOWN_CHECK_MS = 500;
/**
 * How long a Resume opened to type in waits before a terminal that shows no longer counts as having left it: its
 * orchestrator switches the terminal to it as soon as its pane is up, which a check may come before.
 */
const OPEN_GRACE_MS = 2000;
/** How long an approval waits once its orchestrator is gone and no one watches its pane: as on pi's RPC. */
const ORPHAN_BLOCK_MS = 5000;

/** Its generation, which its host, the process that started it, holds; none where no run's spec is. */
function seatOf(runDir: string): HostSeat | undefined {
	try {
		return hostGeneration(runDir, process.ppid);
	} catch {
		return undefined;
	}
}

export default function paneChild(pi: ExtensionAPI): void {
	const runDir = process.env[RUN_PANE_ENV];
	const seat = runDir ? seatOf(runDir) : undefined;
	const pane = seat?.spec.pane;
	if (!runDir || !seat || !pane) return;
	const { spec } = seat;
	/** Whether it waits on a blocking dialog of its own. */
	let awaiting = false;
	const socket = process.env.TMUX?.split(",")[0];
	const tmux = socket ? new Tmux(dirname(socket), undefined, { timeoutMs: 2000 }) : undefined;

	let ctx: ExtensionContext | undefined;
	let done = false;
	/** Set once pi shuts down: it ends by itself, so it is not ended again. */
	let shuttingDown = false;
	/** Whether it has work: a Resume the user opened to type in has none until they type. */
	let working = spec.prompt !== "";
	/** Set once the user stopped its work with Esc: it waits for them, not for its orchestrator. */
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
			// What pi's RPC answers get_available_models with: the models it knows and has authentication for.
			availableModels: async () => ctx?.modelRegistry.getAvailable() ?? [],
		},
		save: seat.saveChild,
		// Its Report is stored, or that nothing was done: its pi ends.
		ended: () => {
			done = true;
			clearInterval(checks);
			awaiting = false;
			seat.saveChild({ awaiting });
			if (!shuttingDown) ctx?.shutdown();
		},
	});

	/** Whether a terminal shows its pane; undefined when tmux cannot say. */
	const isShown = () => {
		try {
			return tmux?.shown(pane.session);
		} catch {
			return undefined;
		}
	};

	/** Its orchestrator's pane, which ← goes back to: another once a reopened session took the run over. */
	let parent = pane.parent;
	const followParent = () => {
		parent = seat.paneParent() ?? pane.parent;
		process.env[PARENT_ENV] = parent;
	};

	/** Aborted to block the approvals it waits on; one aborted is replaced, so a later ask may be answered again. */
	let unanswerable = new AbortController();
	paneApprovalsUnanswerable.set(unanswerable.signal);
	let orphanedSince: number | undefined;
	/**
	 * An approval waits for the user while its orchestrator's panel can say so. Once that orchestrator's pane is gone
	 * and no terminal shows this one for {@link ORPHAN_BLOCK_MS}, it is blocked, as its host would on pi's RPC.
	 */
	const checkOrphaned = () => {
		if (done || !awaiting) {
			orphanedSince = undefined;
			return;
		}
		let parentGone = false;
		try {
			parentGone = tmux?.hasSession(parent) === false;
		} catch {
			// tmux did not answer: checked again next time.
		}
		if (!parentGone || isShown() !== false) {
			orphanedSince = undefined;
			return;
		}
		orphanedSince ??= Date.now();
		if (Date.now() - orphanedSince < ORPHAN_BLOCK_MS) return;
		orphanedSince = undefined;
		unanswerable.abort();
		unanswerable = new AbortController();
		paneApprovalsUnanswerable.set(unanswerable.signal);
	};

	/** Work the user holds, or a Resume they never typed in, ends once they leave its pane. */
	const checkLeft = () => {
		if (done || (working && !held)) return;
		const now = isShown();
		if (now) shown = true;
		// A Resume opened to type in was shown from the start, however soon the user left it.
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

	// The run's session is what its orchestrator follows: the user keeps to it in its pane.
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
			// Its orchestrator still owns the work, so it is told, without a turn (ADR-0005).
			work.send({ kind: "typed", text: event.text });
		}
		return { action: "continue" };
	});

	pi.on("message_end", (event) => work.messageEnded(event.message));
	pi.on("tool_execution_end", (event) => work.toolEnded(event));

	pi.on("agent_settled", (event, settled) => {
		ctx = settled;
		if (done) return;
		// Esc in its pane: the user holds its work until they go on, or leave it. A stop from its host ends the pi.
		if (event.aborted) {
			// Whoever pressed Esc was there.
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

	// Heard before pi's shutdown on it reaches session_shutdown: pi hears it once its pane is ended from outside.
	let paneEnded = false;
	process.on("SIGHUP", () => {
		paneEnded = true;
	});
	// Ended before its work settled, by a stop from its host, the user quitting it or its pane ended: what it did so far
	// is its Report.
	pi.on("session_shutdown", () => {
		shuttingDown = true;
		work.end(working ? { status: "stopped", error: paneEnded ? PANE_ENDED : "its work was stopped" } : undefined);
	});
}
