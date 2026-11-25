import type { InstanceSummary, OrchestratorClient } from "../../daemon/orchestrator-client.ts";
import { type AgentRow, collectRows, rowFromShell } from "../../daemon/rows.ts";
import type { ShellInfo } from "../../daemon/tmux.ts";
import { HEARTBEAT_MS } from "./self-registration.ts";

const RESTART_MARGIN_MS = 2000;
const RESTART_GRACE_MS = HEARTBEAT_MS + RESTART_MARGIN_MS;
const POLL_MS = 1000;

export interface RosterDeps {
	client: Pick<OrchestratorClient, "list" | "setMeta">;
	shells: { list(): ShellInfo[]; listAsync(): Promise<ShellInfo[]> };
	now?: () => number;
	hide?: string;
	seed?: InstanceSummary[];
	changed: () => void;
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
	private readonly pendingOrder = new Map<string, number>();
	private ordering: Promise<void> = Promise.resolve();
	private readonly deletedAt = new Map<string, number>();
	private readonly deleting = new Set<string>();
	private restartedAt = Number.NEGATIVE_INFINITY;
	private stopped = false;

	constructor(deps: RosterDeps) {
		this.deps = deps;
		this.now = deps.now ?? (() => Date.now());
		if (deps.seed) {
			this.instances = deps.seed.filter((inst) => inst.id !== deps.hide);
			this.shells = shellsOrNoneUntilFirstRefresh(deps.shells);
		}
	}

	get connectionLost(): boolean {
		return this.lost;
	}

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
			const listed = (await this.deps.client.list()).filter(
				(inst) => inst.id !== this.deps.hide && !((this.deletedAt.get(inst.id) ?? -1) >= askedAt),
			);
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

	watch(): void {
		this.pollTimer ??= setInterval(() => void this.refresh(), POLL_MS);
	}

	stop(): void {
		this.stopped = true;
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = undefined;
	}

	daemonRestarted(): void {
		this.restartedAt = this.now();
	}

	startDelete(id: string): void {
		this.deleting.add(id);
		this.notify();
	}

	endDelete(id: string): void {
		this.deleting.delete(id);
	}

	deleted(ids: string[]): void {
		for (const id of ids) this.deletedAt.set(id, this.now());
		this.instances = this.instances.filter((i) => !ids.includes(i.id));
		this.notify();
	}

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

	private notify(): void {
		if (!this.stopped) this.deps.changed();
	}
}

function shellsOrNoneUntilFirstRefresh(shells: RosterDeps["shells"]): ShellInfo[] {
	try {
		return shells.list();
	} catch {
		return [];
	}
}
