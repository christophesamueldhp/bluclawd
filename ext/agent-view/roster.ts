/**
 * Agent view's roster: the rows it lists now. The daemon's list as last read and the `!` commands, with what this view
 * just did shown ahead of the daemon confirming it: a row being deleted or just deleted, a Manual order, and the panes
 * a daemon this view restarted has yet to hear from.
 */

import type { InstanceSummary, OrchestratorClient } from "../../daemon/orchestrator-client.ts";
import { type AgentRow, collectRows, rowFromShell } from "../../daemon/rows.ts";
import type { ShellInfo } from "../../daemon/tmux.ts";

/** A pane heartbeats every 3s (self-registration.ts), so a restarted daemon has them all back by this. */
const RESTART_GRACE_MS = 5000;
const POLL_MS = 1000;

export interface RosterDeps {
	client: Pick<OrchestratorClient, "list" | "setMeta">;
	/** The `!` commands the tmux server runs or ran. */
	shells: { list(): ShellInfo[]; listAsync(): Promise<ShellInfo[]> };
	now?: () => number;
	/** A row not to list (see AgentViewOptions.hide). */
	hide?: string;
	/** The daemon's list as read just before the view opened, shown until the first refresh. */
	seed?: InstanceSummary[];
	/** The listed rows changed. */
	changed: () => void;
	/** A Manual order could not be saved. */
	orderFailed: (error: unknown) => void;
}

export class Roster {
	private readonly deps: RosterDeps;
	private readonly now: () => number;
	private instances: InstanceSummary[] = [];
	private shells: ShellInfo[] = [];
	private lost = false;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private refreshing: Promise<void> | undefined;
	private refreshAgain: Promise<void> | undefined;
	/** shift+↑/↓'s order: shown at once, and over any list read before its writes landed. */
	private readonly pendingOrder = new Map<string, number>();
	private ordering: Promise<void> = Promise.resolve();
	/** Rows this view deleted, and when the delete landed. */
	private readonly deletedAt = new Map<string, number>();
	/** Rows whose delete is under way: out of the list until it lands, back if it fails. */
	private readonly deleting = new Set<string>();
	/** When this view restarted an older daemon, which lost every pane's registration. */
	private restartedAt = Number.NEGATIVE_INFINITY;
	private stopped = false;

	constructor(deps: RosterDeps) {
		this.deps = deps;
		this.now = deps.now ?? (() => Date.now());
		if (deps.seed) {
			this.instances = deps.seed.filter((inst) => inst.id !== deps.hide);
			try {
				this.shells = deps.shells.list();
			} catch {
				// listed by the first refresh
			}
		}
	}

	/** The daemon did not answer the last read: the rows are the last known ones. */
	get connectionLost(): boolean {
		return this.lost;
	}

	/** The rows listed now, seen from the session `self`, and the daemon's list they come from, for its runs. */
	listed(self: InstanceSummary | undefined): { instances: InstanceSummary[]; rows: AgentRow[] } {
		const order = this.pendingOrder;
		const instances = order.size
			? this.instances.map((i) => (order.has(i.id) ? { ...i, sortOrder: order.get(i.id) } : i))
			: this.instances;
		const rows = [...collectRows(instances, self), ...this.shells.map(rowFromShell)].filter(
			(r) => !this.deleting.has(r.id),
		);
		return { instances, rows };
	}

	/** Reads the list again. Asked for while a read is in flight, it runs once more when that one lands: its list may
	 *  predate what was just done. */
	refresh(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		if (this.refreshing) {
			this.refreshAgain ??= this.refreshing.then(() => {
				this.refreshAgain = undefined;
				return this.refresh();
			});
			return this.refreshAgain;
		}
		this.refreshing = this.load().finally(() => {
			this.refreshing = undefined;
		});
		return this.refreshing;
	}

	private async load(): Promise<void> {
		const askedAt = this.now();
		try {
			// A list asked for before a delete landed still has its row.
			const listed = (await this.deps.client.list()).filter(
				(inst) => inst.id !== this.deps.hide && !((this.deletedAt.get(inst.id) ?? -1) >= askedAt),
			);
			// A restarted daemon knows a pane only from its next heartbeat: until then its row stays as it
			// was, over the stopped row the daemon stored for it.
			const carried =
				this.now() - this.restartedAt < RESTART_GRACE_MS
					? this.instances.filter(
							(inst) =>
								inst.pane &&
								!this.deletedAt.has(inst.id) &&
								!listed.some((l) => l.id === inst.id && l.external),
						)
					: [];
			this.instances = [...listed.filter((l) => !carried.some((c) => c.id === l.id)), ...carried];
			this.lost = false;
		} catch {
			this.lost = true;
		} finally {
			this.shells = await this.deps.shells.listAsync().catch(() => []);
		}
		this.notify();
	}

	/** Reads the list again every second, until stopped. */
	watch(): void {
		this.pollTimer ??= setInterval(() => void this.refresh(), POLL_MS);
	}

	/** The view is abandoned: nothing is read or reported from here on. */
	stop(): void {
		this.stopped = true;
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = undefined;
	}

	/** This view restarted an older daemon: the panes listed so far are carried until each has beaten again. */
	daemonRestarted(): void {
		this.restartedAt = this.now();
	}

	/** A row's delete is under way: it leaves the list at once. */
	startDelete(id: string): void {
		this.deleting.add(id);
		this.notify();
	}

	/** The delete ended. A row not deleted is back with the next read; one deleted is told with `deleted`. */
	endDelete(id: string): void {
		this.deleting.delete(id);
	}

	/** Rows this view deleted leave the list at once: a refresh just after a daemon restart would carry them. */
	deleted(ids: string[]): void {
		for (const id of ids) this.deletedAt.set(id, this.now());
		this.instances = this.instances.filter((i) => !ids.includes(i.id));
		this.notify();
	}

	/**
	 * A Manual order the user gave, by row: shown at once, and saved. Each call's writes wait for the last one's, so a
	 * quick second press builds on the first; the daemon's order is what shows once the last call's list is in.
	 */
	reorder(order: ReadonlyArray<readonly [id: string, sortOrder: number]>): void {
		for (const [id, sortOrder] of order) this.pendingOrder.set(id, sortOrder);
		this.notify();
		const saved = this.ordering.then(async () => {
			try {
				await Promise.all(order.map(([id, sortOrder]) => this.deps.client.setMeta(id, { sortOrder })));
			} catch (error) {
				this.deps.orderFailed(error);
			}
			await this.refresh();
		});
		this.ordering = saved;
		void saved.then(() => {
			if (this.ordering !== saved) return;
			this.pendingOrder.clear();
			this.notify();
		});
	}

	/** Not once stopped: the view's session may be disposed by then. */
	private notify(): void {
		if (!this.stopped) this.deps.changed();
	}
}
