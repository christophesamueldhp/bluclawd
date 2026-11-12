/**
 * Inside a run's pi in a pane (ADR-0013), what its host does over pi's RPC (rpc-host.ts): it gives the pi its task and
 * the messages posted to it, passes on what it sends, and stores its Report once its work settles with nothing pending,
 * then ends the pi. The user watches and may type meanwhile; work they stop with Esc, and a Resume they opened to type
 * in, wait for them, and end once they leave the pane. An approval waits for the user too, unless its orchestrator is
 * gone and no one watches the pane: then it is blocked. The host takes what this stores once the pi exits.
 */

import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PARENT_ENV, RUN_PANE_ENV, Tmux } from "../../daemon/tmux.ts";
import { BLOCKING_PROMPT_KINDS } from "../agent-view/self-registration.ts";
import { SUBAGENT_MESSAGE_TOOL } from "./messages.ts";
import { textOf } from "./results.ts";
import { PANE_ENDED, type PaneChildState, paneChildStatePath, paneParent, readRpcHostSpec } from "./rpc-host.ts";
import { paneApprovalsUnanswerable } from "./run-approvals.ts";
import {
	markGiven,
	type RunInboxMessage,
	type RunOutboxMessage,
	readRunInbox,
	sealRunInbox,
	unsealRunInbox,
	writeRunOutbox,
} from "./run-mailbox.ts";
import type { RunRuntimeOutcome } from "./runs.ts";
import { storeRunReport, writeAtomicPrivateFile } from "./storage.ts";

/** How often the inbox is looked at, and whether a terminal still shows the pane. */
const CHECK_MS = 100;
const SHOWN_CHECK_MS = 500;
/**
 * How long a Resume opened to type in waits before a terminal that shows no longer counts as having left it: its
 * orchestrator switches the terminal to it as soon as its pane is up, which a check may come before.
 */
const OPEN_GRACE_MS = 2000;
/** How long an approval waits once its orchestrator is gone and no one watches its pane: as on pi's RPC. */
const ORPHAN_BLOCK_MS = 5000;

export default function paneChild(pi: ExtensionAPI): void {
	const runDir = process.env[RUN_PANE_ENV];
	const spec = runDir ? readRpcHostSpec(runDir) : undefined;
	if (!runDir || !spec?.pane) return;
	const { generation, pane } = spec;
	const state: PaneChildState = {};
	const save = () => writeAtomicPrivateFile(paneChildStatePath(runDir), JSON.stringify(state));
	const socket = process.env.TMUX?.split(",")[0];
	const tmux = socket ? new Tmux(dirname(socket), undefined, { timeoutMs: 2000 }) : undefined;

	let ctx: ExtensionContext | undefined;
	let last: { text: string; stopReason?: string; errorMessage?: string } = { text: "" };
	/** Messages from the inbox given to pi, and those of them its conversation does not hold yet. */
	const given = new Set<string>();
	const taken = new Set<string>();
	let waiting: RunInboxMessage[] = [];
	let sent = 0;
	let done = false;
	/** Whether it has work: a Resume the user opened to type in has none until they type. */
	let working = spec.prompt !== "";
	/** Set once the user stopped its work with Esc: it waits for them, not for its orchestrator. */
	let held = false;
	let shown = false;
	const openedAt = Date.now();
	let checks: ReturnType<typeof setInterval>[] = [];

	/** Stores its Report, or, with no outcome, that nothing was done; then ends its pi. */
	const finish = (outcome: RunRuntimeOutcome | undefined, shutdown = true) => {
		if (done) return;
		done = true;
		for (const check of checks) clearInterval(check);
		const untaken = sealRunInbox(runDir, generation).filter(({ id }) => !taken.has(id)).length;
		if (outcome) {
			state.outcome = outcome;
			state.reportSeq = storeRunReport(runDir, {
				text: last.text,
				outcome,
				sessionId: state.sessionId,
				generation,
				...(untaken ? { untaken } : {}),
			});
		} else state.idle = true;
		state.awaiting = false;
		save();
		if (shutdown) ctx?.shutdown();
	};

	/** Gives pi each message not given yet: it steers work under way, and starts work when there is none. */
	const give = (messages: RunInboxMessage[]) => {
		for (const message of messages) {
			if (given.has(message.id) || !ctx) continue;
			given.add(message.id);
			waiting.push(message);
			try {
				pi.sendUserMessage(message.text, ctx.isIdle() ? undefined : { deliverAs: "steer" });
			} catch {
				given.delete(message.id);
				waiting = waiting.filter((held) => held !== message);
				continue;
			}
			markGiven(runDir, generation, message.id);
			working = true;
			held = false;
		}
	};

	/** Once its work settled with nothing pending, and nothing landed in its inbox meanwhile, its Report is stored. */
	const settle = () => {
		if (!ctx || done) return;
		give(readRunInbox(runDir, generation));
		if (!ctx.isIdle() || ctx.hasPendingMessages() || waiting.length > 0) return;
		// What landed before the seal is its to take: it goes on with it.
		const late = sealRunInbox(runDir, generation).filter(({ id }) => !given.has(id));
		if (late.length > 0) {
			unsealRunInbox(runDir, generation);
			give(late);
			return;
		}
		finish(
			last.stopReason === "error"
				? { status: "failed", error: last.errorMessage ?? "its model failed" }
				: { status: "completed" },
		);
	};

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
		parent = paneParent(runDir, generation, pane);
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
		if (done || !state.awaiting) {
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
		if (left) finish(working ? { status: "stopped", error: "the user stopped its work in its pane" } : undefined);
	};

	pi.on("session_start", (event, started) => {
		ctx = started;
		if (event.reason !== "startup") return;
		state.sessionFile = started.sessionManager.getSessionFile();
		state.sessionId = started.sessionManager.getSessionId();
		save();
		// pi starts a new session at a path that holds none, without a word.
		if (spec.sessionFile && !sameFile(state.sessionFile, spec.sessionFile)) {
			return finish({
				status: "failed",
				error: `its pi opened ${state.sessionFile ?? "no session"}, not the run's session ${spec.sessionFile}`,
			});
		}
		// pi lowers a level its model lacks, and takes an id its provider lacks for a custom one, warning only.
		const { provider, id } = started.model ?? {};
		const thinkingLevel = pi.getThinkingLevel();
		const admitted = spec.model;
		if (provider !== admitted.provider || id !== admitted.id || thinkingLevel !== admitted.thinkingLevel) {
			return finish({
				status: "failed",
				error: `its pi runs ${provider ?? "no model"}/${id ?? ""} at thinking ${thinkingLevel}, not ${admitted.provider}/${admitted.id} at thinking ${admitted.thinkingLevel}`,
			});
		}
		if (spec.prompt) pi.sendUserMessage(spec.prompt);
		checks = [
			setInterval(() => {
				if (!done) give(readRunInbox(runDir, generation));
			}, CHECK_MS),
			setInterval(() => {
				followParent();
				checkLeft();
				checkOrphaned();
			}, SHOWN_CHECK_MS),
		];
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
		}
		return { action: "continue" };
	});

	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
		if (message.role === "assistant") {
			last = { text: textOf(message.content), stopReason: message.stopReason, errorMessage: message.errorMessage };
		}
		// pi queues a message in memory only: it is the run's once its conversation holds it.
		const text = message.role === "user" ? textOf(message.content) : undefined;
		const at = waiting.findIndex((held) => held.text === text);
		if (at >= 0) {
			taken.add(waiting[at].id);
			waiting = waiting.filter((_, index) => index !== at);
		}
	});

	// What the run sends out is read off its own tool's results, which its pi alone produces.
	pi.on("tool_execution_end", (event) => {
		if (event.toolName !== SUBAGENT_MESSAGE_TOOL || event.isError) return;
		const details = (event.result as { details?: Omit<RunOutboxMessage, "seq"> } | undefined)?.details;
		if (details) writeRunOutbox(runDir, generation, { ...details, seq: ++sent });
	});

	pi.on("agent_settled", (event, settled) => {
		ctx = settled;
		if (done) return;
		// Esc in its pane: the user holds its work until they go on, or leave it. A stop from its host ends the pi.
		if (event.aborted) {
			// Whoever pressed Esc was there.
			held = shown = true;
			return;
		}
		settle();
	});

	pi.on("ui_prompt_start", (event) => {
		if (!BLOCKING_PROMPT_KINDS.has(event.kind)) return;
		state.awaiting = true;
		save();
	});
	pi.on("ui_prompt_end", (event) => {
		if (!BLOCKING_PROMPT_KINDS.has(event.kind)) return;
		state.awaiting = false;
		save();
	});

	// Heard before pi's shutdown on it reaches session_shutdown: pi hears it once its pane is ended from outside.
	let paneEnded = false;
	process.on("SIGHUP", () => {
		paneEnded = true;
	});
	// Ended before its work settled, by a stop from its host, the user quitting it or its pane ended: what it did so far
	// is its Report.
	pi.on("session_shutdown", () => {
		if (!done)
			finish(
				working ? { status: "stopped", error: paneEnded ? PANE_ENDED : "its work was stopped" } : undefined,
				false,
			);
	});
}

function sameFile(path: string | undefined, expected: string): boolean {
	if (!path) return false;
	try {
		return realpathSync(path) === realpathSync(expected);
	} catch {
		return false;
	}
}
