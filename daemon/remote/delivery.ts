/**
 * Prompt delivery: the one record of what became of each prompt or command a phone sent with an id,
 * from the accepted request to its outcome. One is in its pane's inbox until a heartbeat takes it
 * (delivered), then settles with the outcome its pane reports, or is lost when its pane goes first
 * (refused, when the pane left its session for another).
 * Only in memory: a restarted daemon knows none of them.
 */
import { type EndReason, endedForAnother, type PaneMessage, type PromptOutcome } from "../ipc/protocol.ts";

/** How long a prompt is kept after its last change, so a phone that reconnects still reads it. */
export const DELIVERY_KEEP_MS = 10 * 60_000;

/** `sent`: in the pane's inbox, or delivered to the pane and not reported on yet. `pane`: the pane
 *  whose heartbeat took it, once one did. */
type Delivery = PromptOutcome & { sessionId: string; changedAt: number; pane?: string };

/** The phone's id of a message, when it is one whose outcome the phone waits for. */
function phoneId(message: PaneMessage): string | undefined {
	return message.type === "prompt" || message.type === "command" ? message.id : undefined;
}

/** A pane reports these; a queued one is taken later or lost (pi dropped it), and nothing comes after the others. */
function settled(delivery: Delivery): boolean {
	return delivery.outcome !== "sent" && delivery.outcome !== "queued";
}

export class PromptDelivery {
	/** By the phone's id, in the order sent. */
	private readonly prompts = new Map<string, Delivery>();
	private readonly queue: (sessionId: string, message: PaneMessage) => boolean;

	/** `queue`: puts a message in its pane's inbox; false when no pane is registered as that id. */
	constructor(queue: (sessionId: string, message: PaneMessage) => boolean) {
		this.queue = queue;
	}

	/** Queue a message for a pane, keeping track of a prompt or command that carries an id. */
	send(sessionId: string, message: PaneMessage, now: number = Date.now()): boolean {
		if (!this.queue(sessionId, message)) return false;
		this.prune(now);
		const id = phoneId(message);
		if (id) this.prompts.set(id, { id, outcome: "sent", sessionId, changedAt: now });
		return true;
	}

	/** What a pane reports of the prompts it was given; any other id is not its to report. */
	reported(sessionId: string, outcomes: PromptOutcome[], now: number = Date.now()): void {
		for (const outcome of outcomes) {
			const delivery = this.prompts.get(outcome.id);
			if (delivery?.sessionId !== sessionId || settled(delivery) || delivery.outcome === outcome.outcome) continue;
			this.prompts.set(outcome.id, { ...outcome, sessionId, pane: delivery.pane, changedAt: now });
		}
	}

	/** Pane `pane`'s heartbeat took `messages`. */
	delivered(pane: string, messages: PaneMessage[]): void {
		for (const message of messages) {
			const delivery = this.prompts.get(phoneId(message) ?? "");
			if (delivery) delivery.pane = pane;
		}
	}

	/** The pane listed as `sessionId` went, with `inbox` still queued for it: those never reach pi,
	 *  and it can no longer report on what it was given. One pi queued dies with it. `reason`: why its
	 *  session ended, when it said; one it left for another session refuses them, as that session's
	 *  pane would. `pane`: that pane, so what another pane listed as the same row was given stays its
	 *  own; when not given, any pane's. */
	dropped(sessionId: string, inbox: PaneMessage[], reason?: EndReason, pane?: string, now: number = Date.now()): void {
		const changed = endedForAnother(reason);
		const ids = new Set(inbox.map(phoneId));
		const given = (delivery: Delivery) =>
			delivery.sessionId === sessionId && (pane === undefined || delivery.pane === pane);
		for (const [id, delivery] of this.prompts) {
			if (settled(delivery) || !(ids.has(id) || given(delivery))) continue;
			const outcome: PromptOutcome = changed
				? { id, outcome: "refused", reason: "session_changed" }
				: { id, outcome: "lost", reason: "pane_gone" };
			this.prompts.set(id, { ...outcome, sessionId: delivery.sessionId, changedAt: now });
		}
	}

	/** A pane that may still be alive was reaped with `inbox` queued for it: those never reach pi, and
	 *  what it was given waits on its report. */
	silent(inbox: PaneMessage[], now: number = Date.now()): void {
		const ids = new Set(inbox.map(phoneId));
		for (const [id, delivery] of this.prompts) {
			if (settled(delivery) || !ids.has(id)) continue;
			this.prompts.set(id, {
				id,
				outcome: "lost",
				reason: "pane_gone",
				sessionId: delivery.sessionId,
				changedAt: now,
			});
		}
	}

	/** The outcomes of the prompts sent to a session, in the order sent. */
	outcomes(sessionId: string, now: number = Date.now()): PromptOutcome[] {
		this.prune(now);
		const out: PromptOutcome[] = [];
		for (const { sessionId: to, changedAt: _, pane: __, ...outcome } of this.prompts.values()) {
			if (to === sessionId) out.push(outcome);
		}
		return out;
	}

	private prune(now: number): void {
		for (const [id, delivery] of this.prompts) {
			// A queued prompt waits on the turn ahead of it, however long that runs.
			if (delivery.outcome !== "queued" && now - delivery.changedAt > DELIVERY_KEEP_MS) this.prompts.delete(id);
		}
	}
}
