import { randomUUID } from "node:crypto";
import { type EndReason, endedForAnother, type PaneMessage, type PromptOutcome } from "../ipc/protocol.ts";

export const DELIVERY_KEEP_MS = 10 * 60_000;

export interface Waiting {
	id: string;
	lifetime: string;
}

type Delivery = PromptOutcome & { rowId: string; changedAt: number; pane?: string };

function phoneId(message: PaneMessage): string | undefined {
	return message.type === "prompt" || message.type === "command" ? message.id : undefined;
}

function settled(delivery: Delivery): boolean {
	return delivery.outcome !== "sent" && delivery.outcome !== "queued";
}

function expired(delivery: Delivery, now: number): boolean {
	return delivery.outcome !== "queued" && now - delivery.changedAt > DELIVERY_KEEP_MS;
}

export class PromptDelivery {
	settledByPaneGoing: ((rowId: string) => void) | undefined;
	readonly lifetime = randomUUID();
	private readonly now: () => number;
	private readonly prompts = new Map<string, Delivery>();
	private readonly inboxes = new Map<string, PaneMessage[]>();

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	queue(rowId: string, message: PaneMessage): void {
		const now = this.now();
		this.prune(now);
		this.inboxes.set(rowId, [...(this.inboxes.get(rowId) ?? []), message]);
		const id = phoneId(message);
		if (id) this.prompts.set(id, { id, outcome: "sent", rowId, changedAt: now });
	}

	pending(rowId: string): boolean {
		return this.inboxes.has(rowId);
	}

	take(rowId: string, pane: string): PaneMessage[] {
		const messages = this.inboxes.get(rowId) ?? [];
		this.inboxes.delete(rowId);
		for (const message of messages) {
			const delivery = this.prompts.get(phoneId(message) ?? "");
			if (delivery) delivery.pane = pane;
		}
		return messages;
	}

	reported(rowId: string, outcomes: PromptOutcome[]): void {
		for (const outcome of outcomes) {
			const delivery = this.prompts.get(outcome.id);
			if (delivery?.rowId !== rowId || settled(delivery) || delivery.outcome === outcome.outcome) continue;
			this.prompts.set(outcome.id, { ...outcome, rowId, pane: delivery.pane, changedAt: this.now() });
		}
	}

	ended(rowId: string, pane: string, reason: EndReason | undefined, wasListedPane: boolean): void {
		const queued = wasListedPane ? this.takeInbox(rowId) : new Set<string>();
		this.settle(rowId, (id, d) => queued.has(id) || d.pane === pane, reason);
	}

	silent(rowId: string): void {
		const queued = this.takeInbox(rowId);
		this.settle(rowId, (id) => queued.has(id), undefined);
	}

	private takeInbox(rowId: string): Set<string> {
		const messages = this.inboxes.get(rowId) ?? [];
		this.inboxes.delete(rowId);
		return new Set(messages.flatMap((message) => phoneId(message) ?? []));
	}

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
		this.settledByPaneGoing?.(rowId);
	}

	outcomes(rowId: string): PromptOutcome[] {
		this.prune(this.now());
		const out: PromptOutcome[] = [];
		for (const { rowId: to, changedAt: _, pane: __, ...outcome } of this.prompts.values()) {
			if (to === rowId) out.push(outcome);
		}
		return out;
	}

	answer(rowId: string, waiting: Waiting[], reportsOutcomes: boolean): PromptOutcome[] {
		const known = new Map(this.outcomes(rowId).map((outcome) => [outcome.id, outcome]));
		return waiting.flatMap(({ id, lifetime }): PromptOutcome[] => {
			const outcome = known.get(id);
			if (outcome) return [outcome];
			if (this.lostToRestart(lifetime, reportsOutcomes))
				return [{ id, outcome: "lost", reason: "daemon_restarted" }];
			return [];
		});
	}

	private lostToRestart(lifetime: string, reportsOutcomes: boolean): boolean {
		return lifetime !== this.lifetime && reportsOutcomes;
	}

	private prune(now: number): void {
		for (const [id, delivery] of this.prompts) {
			if (expired(delivery, now)) this.prompts.delete(id);
		}
	}
}
