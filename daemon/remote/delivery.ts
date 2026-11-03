/**
 * Prompt delivery: the one record of what became of each prompt a phone sent with an id, from the
 * accepted request to its outcome. A prompt is in its pane's inbox until a heartbeat takes it
 * (delivered), then settles with the outcome its pane reports. Only in memory: a restarted daemon
 * knows none of them.
 */
import type { PaneMessage, PromptOutcome } from "../ipc/protocol.ts";

/** How long a prompt is kept after its last change, so a phone that reconnects still reads it. */
export const DELIVERY_KEEP_MS = 10 * 60_000;

type Stage = "inbox" | "delivered" | PromptOutcome["outcome"];

interface Delivery {
	sessionId: string;
	stage: Stage;
	changedAt: number;
}

export class PromptDelivery {
	/** By the phone's id, in the order sent. */
	private readonly prompts = new Map<string, Delivery>();
	private readonly queue: (sessionId: string, message: PaneMessage) => boolean;

	/** `queue`: puts a message in its pane's inbox; false when no pane is registered as that id. */
	constructor(queue: (sessionId: string, message: PaneMessage) => boolean) {
		this.queue = queue;
	}

	/** Queue a message for a pane, keeping track of a prompt that carries an id. */
	send(sessionId: string, message: PaneMessage, now: number = Date.now()): boolean {
		if (!this.queue(sessionId, message)) return false;
		this.prune(now);
		if (message.type === "prompt" && message.id) {
			this.prompts.set(message.id, { sessionId, stage: "inbox", changedAt: now });
		}
		return true;
	}

	/** A pane's heartbeat took these messages from its inbox. */
	delivered(sessionId: string, messages: PaneMessage[], now: number = Date.now()): void {
		for (const message of messages) {
			if (message.type !== "prompt" || !message.id) continue;
			const delivery = this.prompts.get(message.id);
			if (delivery?.sessionId === sessionId && delivery.stage === "inbox") {
				delivery.stage = "delivered";
				delivery.changedAt = now;
			}
		}
	}

	/** What a pane reports of the prompts it was given; any other id is not its to report. */
	reported(sessionId: string, outcomes: PromptOutcome[], now: number = Date.now()): void {
		for (const { id, outcome } of outcomes) {
			const delivery = this.prompts.get(id);
			if (delivery?.sessionId !== sessionId || delivery.stage === outcome) continue;
			delivery.stage = outcome;
			delivery.changedAt = now;
		}
	}

	/** The outcomes of the prompts sent to a session, in the order sent. */
	outcomes(sessionId: string, now: number = Date.now()): PromptOutcome[] {
		this.prune(now);
		const out: PromptOutcome[] = [];
		for (const [id, { sessionId: to, stage }] of this.prompts) {
			if (to === sessionId && (stage === "taken" || stage === "queued")) out.push({ id, outcome: stage });
		}
		return out;
	}

	private prune(now: number): void {
		for (const [id, delivery] of this.prompts) {
			// A queued prompt waits on the turn ahead of it, however long that runs.
			if (delivery.stage !== "queued" && now - delivery.changedAt > DELIVERY_KEEP_MS) this.prompts.delete(id);
		}
	}
}
