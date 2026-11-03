/**
 * What became of the phone's prompts in this pane, by the phone's ids, for the pane's report. pi's
 * `input` event names no prompt, so a phone prompt is known by its exact text, from an extension,
 * oldest first: queued when pi delivers it as a follow-up, else taken. A queued one is taken when pi
 * starts it, which pi itself tells by its text. One the pane refuses is reported refused, with why.
 * One still queued once pi's queue is empty, or when its session ends, is lost: pi dropped it.
 */
import { contentText } from "@earendil-works/pi-ai";
import type { PromptOutcome, RefusedReason } from "../../daemon/ipc/protocol.ts";

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

interface Sent {
	id: string;
	text: string;
}

export class PromptOutcomes {
	/** Sent to pi, before its input event. */
	private readonly waiting: Sent[] = [];
	/** Queued by pi behind the turn in progress. */
	private readonly queued: Sent[] = [];
	private readonly settled: PromptOutcome[] = [];

	/** The pane hands pi a phone prompt with this text. */
	sent(id: string, text: string): void {
		this.waiting.push({ id, text });
		this.waiting.splice(0, this.waiting.length - KEPT);
	}

	/** pi's input event; true when it settles a phone prompt. */
	input(event: { text: string; source: string; streamingBehavior?: string }): boolean {
		if (event.source !== "extension") return false;
		const prompt = take(this.waiting, event.text);
		if (!prompt) return false;
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
		const prompt = take(this.queued, contentText(message.content as Parameters<typeof contentText>[0]));
		if (!prompt) return false;
		this.settle({ id: prompt.id, outcome: "taken" });
		return true;
	}

	/** pi's queue no longer holds the queued phone prompts it did not start; true when there were any. */
	dequeued(): boolean {
		const dropped = this.queued.splice(0);
		for (const prompt of dropped) this.settle({ id: prompt.id, outcome: "lost", reason: "dequeued" });
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
