/**
 * Prompt delivery: each row's inbox, and the one record of what became of each prompt or command a
 * phone sent with an id, from the accepted request to its outcome. One waits in its row's inbox
 * until its pane's heartbeat takes it, then settles with the outcome its pane reports, or is lost
 * when its pane goes first (refused, when the pane left its session for another). The row table
 * tells it when a pane ends or falls silent.
 * Only in memory: a restarted daemon knows none of them.
 */
import { type EndReason, endedForAnother, type PaneMessage, type PromptOutcome } from "../ipc/protocol.ts";

/** How long a prompt is kept after its last change, so a phone that reconnects still reads it. */
export const DELIVERY_KEEP_MS = 10 * 60_000;

/** `sent`: in its row's inbox, or taken by its pane and not reported on yet. `pane`: the pane whose
 *  heartbeat took it, once one did. */
type Delivery = PromptOutcome & { rowId: string; changedAt: number; pane?: string };

/** The phone's id of a message, when it is one whose outcome the phone waits for. */
function phoneId(message: PaneMessage): string | undefined {
	return message.type === "prompt" || message.type === "command" ? message.id : undefined;
}

/** A pane reports these; a queued one is taken later or lost (pi dropped it), and nothing comes after the others. */
function settled(delivery: Delivery): boolean {
	return delivery.outcome !== "sent" && delivery.outcome !== "queued";
}

export class PromptDelivery {
	/** Row `rowId`'s outcomes changed as its pane ended or fell silent. */
	changed: ((rowId: string) => void) | undefined;
	private readonly now: () => number;
	/** By the phone's id, in the order sent. */
	private readonly prompts = new Map<string, Delivery>();
	/** Messages for each row's live pane's pi, by row id, taken by its next heartbeat. */
	private readonly inboxes = new Map<string, PaneMessage[]>();

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	/** Into row `rowId`'s inbox, keeping track of a prompt or command that carries an id. The row
	 *  table queues only for a row whose pane is live. */
	queue(rowId: string, message: PaneMessage): void {
		const now = this.now();
		this.prune(now);
		this.inboxes.set(rowId, [...(this.inboxes.get(rowId) ?? []), message]);
		const id = phoneId(message);
		if (id) this.prompts.set(id, { id, outcome: "sent", rowId, changedAt: now });
	}

	/** Whether anything waits in row `rowId`'s inbox. */
	pending(rowId: string): boolean {
		return this.inboxes.has(rowId);
	}

	/** Pane `pane`'s heartbeat takes what waits in row `rowId`'s inbox. */
	take(rowId: string, pane: string): PaneMessage[] {
		const messages = this.inboxes.get(rowId) ?? [];
		this.inboxes.delete(rowId);
		for (const message of messages) {
			const delivery = this.prompts.get(phoneId(message) ?? "");
			if (delivery) delivery.pane = pane;
		}
		return messages;
	}

	/** What row `rowId`'s pane reports of the prompts it was given; any other id is not its to report. */
	reported(rowId: string, outcomes: PromptOutcome[]): void {
		for (const outcome of outcomes) {
			const delivery = this.prompts.get(outcome.id);
			if (delivery?.rowId !== rowId || settled(delivery) || delivery.outcome === outcome.outcome) continue;
			this.prompts.set(outcome.id, { ...outcome, rowId, pane: delivery.pane, changedAt: this.now() });
		}
	}

	/** Pane `pane`, listed as row `rowId` or held by it, ended: it can no longer report on what it
	 *  was given, and one pi queued dies with it. `inbox`: it was the row's pane, so what its inbox
	 *  holds never reaches pi either; a pane the row held has none. `reason`: why its session ended,
	 *  when it said; one it left for another session refuses them, as that session's pane would. */
	ended(rowId: string, pane: string, reason: EndReason | undefined, inbox: boolean): void {
		const queued = inbox ? this.takeInbox(rowId) : new Set<string>();
		this.settle(rowId, (id, d) => queued.has(id) || d.pane === pane, reason);
	}

	/** Row `rowId`'s pane, which may still be alive, fell silent: what its inbox holds never reaches
	 *  pi, and what it was given waits on its report. */
	silent(rowId: string): void {
		const queued = this.takeInbox(rowId);
		this.settle(rowId, (id) => queued.has(id), undefined);
	}

	/** The phone's ids of what row `rowId`'s inbox held, now emptied. */
	private takeInbox(rowId: string): Set<string> {
		const messages = this.inboxes.get(rowId) ?? [];
		this.inboxes.delete(rowId);
		return new Set(messages.flatMap((message) => phoneId(message) ?? []));
	}

	/** The unsettled prompts of row `rowId` that `ends`, as their pane's going leaves them. */
	private settle(
		rowId: string,
		ends: (id: string, delivery: Delivery) => boolean,
		reason: EndReason | undefined,
	): void {
		const outcome = endedForAnother(reason)
			? ({ outcome: "refused", reason: "session_changed" } as const)
			: ({ outcome: "lost", reason: "pane_gone" } as const);
		for (const [id, delivery] of this.prompts) {
			if (delivery.rowId !== rowId || settled(delivery) || !ends(id, delivery)) continue;
			this.prompts.set(id, { id, ...outcome, rowId, changedAt: this.now() });
		}
		this.changed?.(rowId);
	}

	/** The outcomes of the prompts sent to row `rowId`, in the order sent. */
	outcomes(rowId: string): PromptOutcome[] {
		this.prune(this.now());
		const out: PromptOutcome[] = [];
		for (const { rowId: to, changedAt: _, pane: __, ...outcome } of this.prompts.values()) {
			if (to === rowId) out.push(outcome);
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
