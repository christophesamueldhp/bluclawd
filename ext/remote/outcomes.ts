/**
 * What became of the phone's prompts in this pane, by the phone's ids, for the pane's report. pi's
 * `input` event names no prompt, so a phone prompt is known by its exact text, from an extension,
 * oldest first: queued when pi delivers it as a follow-up, else taken. A queued one is taken when pi
 * starts it, which pi itself tells by its text. One the pane refuses is reported refused, with why.
 * One seen in pi's queue, then gone from it unstarted, is lost: pi dropped it. pi tells an extension
 * only whether its queue holds anything, and queues a prompt only after its input handlers have all
 * run, so one never seen there may yet run as a turn of its own: it is lost only once pi has been
 * idle with an empty queue for QUIET_LOOKS heartbeats in a row. Any still queued when its session
 * ends is lost.
 */
import { contentText } from "@earendil-works/pi-ai";
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

	/** The pane hands pi a phone prompt with this text. */
	sent(id: string, text: string): void {
		this.waiting.push({ id, text });
		this.waiting.splice(0, this.waiting.length - KEPT);
	}

	/** pi's input event; true when it settles a phone prompt. */
	input(event: { text: string; source: string; streamingBehavior?: string }): boolean {
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
	started(message: { role: string; content?: unknown }): boolean {
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

	/** Whether pi's queue holds anything now, and whether pi is idle. Only a lone queued phone prompt,
	 *  no other entrant queued, is then seen there: with two, the other may be what it holds, the
	 *  second one seen once the first is taken. An entrant still in its input handlers is queued later
	 *  if pi still streams then, so entrants are forgotten only once pi is idle with its queue empty:
	 *  one not started by then pi dropped, or runs as a turn of its own. */
	looked(pending: boolean, idle: boolean): void {
		const [only] = this.queued;
		if (pending && only && this.queued.length === 1 && this.others.length === 0) only.seen = true;
		if (!pending && idle) this.others.length = 0;
	}

	/** pi's queue no longer holds the phone prompts seen in it that it did not start, nor, once pi has
	 *  been idle with it empty for `quietLooks` heartbeats as many as QUIET_LOOKS, any other; true when
	 *  there were any. */
	dequeued(quietLooks = 0): boolean {
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
