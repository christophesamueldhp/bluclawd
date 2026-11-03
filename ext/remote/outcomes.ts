/**
 * What became of the phone's prompts in this pane, by the phone's ids, for the pane's report. pi's
 * `input` event names no prompt, so a phone prompt is known by its exact text, from an extension,
 * oldest first: queued when pi delivers it as a follow-up, else taken. A queued one is taken when pi
 * starts it, which pi itself tells by its text.
 */
import { contentText } from "@earendil-works/pi-ai";
import type { PromptOutcome } from "../../daemon/ipc/protocol.ts";

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
			this.settle(prompt.id, "queued");
		} else this.settle(prompt.id, "taken");
		return true;
	}

	/** pi starts a user message; true when it is a queued phone prompt, taken now. */
	started(message: { role: string; content?: unknown }): boolean {
		if (message.role !== "user") return false;
		const prompt = take(this.queued, contentText(message.content as Parameters<typeof contentText>[0]));
		if (!prompt) return false;
		this.settle(prompt.id, "taken");
		return true;
	}

	list(): PromptOutcome[] {
		return this.settled.map(({ id, outcome }) => ({ id, outcome }));
	}

	private settle(id: string, outcome: PromptOutcome["outcome"]): void {
		const known = this.settled.find((o) => o.id === id);
		if (known) known.outcome = outcome;
		else this.settled.push({ id, outcome });
		this.settled.splice(0, this.settled.length - KEPT);
	}
}

/** The oldest prompt with this text, taken out of `list`. */
function take(list: Sent[], text: string): Sent | undefined {
	const at = list.findIndex((p) => p.text === text);
	return at < 0 ? undefined : list.splice(at, 1)[0];
}
