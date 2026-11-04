/**
 * What became of the phone's prompts in this pane, by the phone's ids, for the pane's report. pi's
 * `input` event names no prompt, so a phone prompt is known by its exact text, from an extension,
 * oldest first: queued when pi delivers it as a follow-up, else taken. A queued one is taken when pi
 * starts it, which pi itself tells by its text. One the pane refuses is reported refused, with why.
 * One seen in pi's queue, then gone from it unstarted, is lost: pi dropped it. pi tells an extension
 * only whether its queue holds anything, and queues a prompt only after its input handlers have all
 * run, so one never seen there may yet run as a turn of its own: it is lost only once pi has been
 * idle with an empty queue for QUIET_LOOKS heartbeats in a row. Any still queued when its session
 * ends other than by a quit is lost. The tracker follows pi's events and the pane's heartbeats
 * itself, and hands its caller each report it needs sent.
 */
import { contentText } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PromptOutcome, RefusedReason } from "../../daemon/ipc/protocol.ts";
import { HEARTBEAT_MS } from "../agent-view/self-registration.ts";

/**
 * Why a pane refuses a phone's prompt or command before pi sees it, if it does: it was sent to
 * another session than the pane's (a reload or `/resume` of the same file is that session still;
 * a fork is another), or pi is compacting at the user's request, when pi throws on a prompt.
 */
export function refusal(
	message: { sessionFile?: string },
	session: { compacting: boolean; sessionFile?: string },
): RefusedReason | undefined {
	const sent = message.sessionFile;
	if (sent && sent !== session.sessionFile) return "session_changed";
	if (session.compacting) return "compacting";
	return undefined;
}

/** How many each report carries: one that went with a dropped report comes with the next. */
const KEPT = 20;

/** How many heartbeats in a row find pi idle with an empty queue before a queued phone prompt never
 *  seen in it is taken as dropped, about 30s: input handlers that await that long are not expected.
 *  Counted rather than timed, so a Mac waking from sleep has not been quiet all along. */
export const QUIET_LOOKS = Math.ceil(30_000 / HEARTBEAT_MS);

interface Sent {
	id: string;
	text: string;
	/** Seen in pi's queue. */
	seen?: boolean;
}

export class PromptOutcomes {
	/** Sent to pi, before its input event. */
	private readonly waiting: Sent[] = [];
	/** Queued by pi behind the turn in progress, or to be once its input handlers are done. */
	private readonly queued: Sent[] = [];
	/** The text of every other entrant pi queues, or will once its input handlers are done: the Mac's
	 *  follow-ups and steers, other extensions' prompts. */
	private readonly others: string[] = [];
	private readonly settled: PromptOutcome[] = [];
	/** The session's context, for the heartbeat, which carries none; gone once the session ends. */
	private ctx: ExtensionContext | undefined;
	/** How many heartbeats in a row have found pi idle with an empty queue: a run between two of them
	 *  ends in agent_settled, which starts the count over. */
	private quietLooks = 0;
	/** pi is compacting at the user's request, when it throws on a prompt. */
	private compacting = false;
	private readonly report: (ctx: ExtensionContext) => Promise<void>;

	/** `heartbeat`: calls its argument after each of the pane's heartbeats, which come whether or not
	 *  the daemon answers. `report`: sends what the tracker settled from pi's events, resolving once
	 *  the daemon has it. */
	constructor(
		pi: Pick<ExtensionAPI, "on">,
		heartbeat: (look: () => void) => void,
		report: (ctx: ExtensionContext) => Promise<void>,
	) {
		this.report = report;
		pi.on("session_start", (_event, ctx) => {
			this.ctx = ctx;
		});
		// pi throws on a prompt only while the user's compaction runs; its own automatic one queues it.
		pi.on("session_before_compact", (event) => {
			if (event.reason === "manual") this.compacting = true;
		});
		pi.on("session_compact", () => {
			this.compacting = false;
		});
		pi.on("session_compact_failed", () => {
			this.compacting = false;
		});
		pi.on("input", (event, ctx) => {
			if (!this.input(event)) return;
			void this.report(ctx);
			// pi queues it once every input handler is done, and tells no extension: a tick later when
			// none awaits anything.
			if (event.streamingBehavior) setTimeout(() => this.ctx && this.look(this.ctx, "input"), 0);
		});
		pi.on("message_start", (event, ctx) => {
			if (this.started(event.message)) void this.report(ctx);
		});
		// pi's run is over, retries and queued follow-ups included. Its queue is empty unless the run was
		// stopped without clearing it, as a session switch does: then a later look, or session_shutdown, settles them.
		pi.on("agent_settled", (_event, ctx) => this.look(ctx, "settled"));
		heartbeat(() => {
			if (this.ctx) this.look(this.ctx, "heartbeat");
		});
		pi.on("session_shutdown", async (event, ctx) => {
			// Its context is stale once the session is replaced: no look after this one.
			this.ctx = undefined;
			// Its queue goes with the session, and every queued phone prompt with it, seen there or not:
			// one whose input handlers still run, pi 1.0.4 runs in the disposed session, which no
			// transcript shows and no pane hears of. pi awaits this, so the report lands before the pane
			// stops. Not at quit, which agent view does not hold up either: the daemon finds the pane gone.
			if (event.reason !== "quit" && this.dequeued(Number.POSITIVE_INFINITY)) await this.report(ctx);
		});
	}

	/** Why the pane refuses a phone's prompt or command before pi sees it, if it does, in a session on
	 *  `sessionFile`. */
	refusal(message: { sessionFile?: string }, sessionFile: string | undefined): RefusedReason | undefined {
		return refusal(message, { compacting: this.compacting, sessionFile });
	}

	/** The pane hands pi a phone prompt with this content, known in pi's input event by its text joined
	 *  as pi joins it. */
	sent(id: string, content: Parameters<typeof contentText>[0]): void {
		this.waiting.push({ id, text: contentText(content) });
		this.waiting.splice(0, this.waiting.length - KEPT);
	}

	/** pi's input event; true when it settles a phone prompt. */
	private input(event: { text: string; source: string; streamingBehavior?: string }): boolean {
		const prompt = event.source === "extension" ? take(this.waiting, event.text) : undefined;
		if (!prompt) {
			if (event.streamingBehavior) {
				this.others.push(event.text);
				this.others.splice(0, this.others.length - KEPT);
			}
			return false;
		}
		if (event.streamingBehavior === "followUp") {
			this.queued.push(prompt);
			this.queued.splice(0, this.queued.length - KEPT);
			this.settle({ id: prompt.id, outcome: "queued" });
		} else this.settle({ id: prompt.id, outcome: "taken" });
		return true;
	}

	/** pi starts a user message; true when it is a queued phone prompt, taken now. */
	private started(message: { role: string; content?: unknown }): boolean {
		if (message.role !== "user") return false;
		const text = contentText(message.content as Parameters<typeof contentText>[0]);
		const prompt = take(this.queued, text);
		if (!prompt) {
			const at = this.others.indexOf(text);
			if (at >= 0) this.others.splice(at, 1);
			return false;
		}
		this.settle({ id: prompt.id, outcome: "taken" });
		return true;
	}

	/** pi's queue, which pi tells no extension it changes (Esc and the dequeue key empty it): a phone
	 *  prompt seen in it, gone from it unstarted while pi is idle, pi dropped. `by`: what looks.
	 *  Only a lone queued phone prompt, no other entrant queued, is seen there: with two, the other
	 *  may be what it holds, the second one seen once the first is taken. An entrant still in its input
	 *  handlers is queued later if pi still streams then, so entrants are forgotten only once pi is idle
	 *  with its queue empty: one not started by then pi dropped, or runs as a turn of its own. */
	private look(ctx: ExtensionContext, by: "input" | "settled" | "heartbeat"): void {
		const pending = ctx.hasPendingMessages();
		const idle = ctx.isIdle();
		const quiet = !pending && idle;
		const [only] = this.queued;
		if (pending && only && this.queued.length === 1 && this.others.length === 0) only.seen = true;
		if (quiet) this.others.length = 0;
		if (!quiet || by === "settled") this.quietLooks = 0;
		else if (by === "heartbeat") this.quietLooks++;
		if (quiet && this.dequeued(this.quietLooks)) void this.report(ctx);
	}

	/** pi's queue no longer holds the phone prompts seen in it that it did not start, nor, once pi has
	 *  been idle with it empty for `quietLooks` heartbeats as many as QUIET_LOOKS, any other; true when
	 *  there were any. */
	private dequeued(quietLooks: number): boolean {
		const dropped = this.queued.filter((prompt) => prompt.seen || quietLooks >= QUIET_LOOKS);
		for (const prompt of dropped) {
			this.queued.splice(this.queued.indexOf(prompt), 1);
			this.settle({ id: prompt.id, outcome: "lost", reason: "dequeued" });
		}
		return dropped.length > 0;
	}

	/** The pane did not hand it to pi, for `reason`. */
	refused(id: string, reason: RefusedReason): void {
		this.settle({ id, outcome: "refused", reason });
	}

	/** A slash command, which pi runs with no input event: taken once Enter is pressed for it. */
	taken(id: string): void {
		this.settle({ id, outcome: "taken" });
	}

	list(): PromptOutcome[] {
		return this.settled.map((outcome) => ({ ...outcome }));
	}

	private settle(outcome: PromptOutcome): void {
		const at = this.settled.findIndex((o) => o.id === outcome.id);
		if (at >= 0) this.settled[at] = outcome;
		else this.settled.push(outcome);
		this.settled.splice(0, this.settled.length - KEPT);
	}
}

/** The oldest prompt with this text, taken out of `list`. */
function take(list: Sent[], text: string): Sent | undefined {
	const at = list.findIndex((p) => p.text === text);
	return at < 0 ? undefined : list.splice(at, 1)[0];
}
