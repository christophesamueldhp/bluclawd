import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { HELD_REQUEST_TIMEOUT_MS } from "./ipc/protocol.ts";
import { runMachMarker } from "./run-members.ts";

/**
 * What an orchestrator gives the daemon to start a run's host with. The environment is the orchestrator's, which the
 * run's pi gets, and travels in memory only, never to disk.
 */
export interface RunHostLaunch {
	runDir: string;
	env: Record<string, string>;
	/**
	 * For a run with a shell, the processes its commands started, which the daemon finds by the run's marker
	 * (daemon/run-members.ts), may have left the host's group, and its slot is held until they end too.
	 */
	contained?: boolean;
	/** The tmux session of agent view's server to start the host in, for a run in a pane (ADR-0013); else detached. */
	pane?: string;
}

export interface SlotClaim {
	granted: boolean;
	claimed?: true;
	active: number;
	capacity: number;
}

const CODE_INJECTION_ENV = ["NODE_OPTIONS", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD"];

export function hostSafeEnv(env: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(env).filter(([key]) => !CODE_INJECTION_ENV.includes(key) && key !== "PI_PACKAGE_ROOT"),
	);
}

export const runPaneSession = (runId: string, generation: number) => `${runId}-${generation}`;
export const runQueueKey = (runId: string, generation: number) => `${runId}/${generation}`;
const RUN_PANE = /^sub_[\w-]+-\d+$/;

export const RUN_CLAIM_WAIT_MS = HELD_REQUEST_TIMEOUT_MS - 5_000;
const LAUNCH_LEASE_MS = 60_000;
const UNCLAIMED_MS = 2 * RUN_CLAIM_WAIT_MS;
const CHECK_MS = 200;
const DEFAULT_CAPACITY = 4;

export function userMaxActiveRuns(agentDir: string): number | undefined {
	let max: unknown;
	try {
		max = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))?.subagents?.maxActive;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? DEFAULT_CAPACITY : undefined;
	}
	return typeof max === "number" && Number.isInteger(max) && max > 0 ? max : DEFAULT_CAPACITY;
}

export interface RunQueueDeps {
	now: () => number;
	spawn: (launch: RunHostLaunch) => number;
	running: (pid: number) => boolean;
	sweepStragglers: (pid: number, marker: string) => "sweeping" | "swept";
	capacity: () => number | undefined;
	store?: { load(): ActiveRun[]; save(runs: ActiveRun[]): void };
}

export interface ActiveRun {
	run: string;
	parent: string;
	pid: number;
	contained?: boolean;
}

interface Entry {
	parent: string;
	state: "queued" | "granted" | "active";
	answer?: (granted: boolean) => void;
	claimedAt: number;
	grantedAt?: number;
	pid?: number;
	contained?: boolean;
	pane?: { name: string; env?: Record<string, string> };
}

const RUN_KEY = /^(sub_[\w-]+)\/\d+$/;

const markerOf = (run: string, contained: boolean | undefined) => {
	const runId = RUN_KEY.exec(run)?.[1];
	return contained && runId ? runMachMarker(runId) : undefined;
};

function invalidLaunch(run: string, host: RunHostLaunch): string | undefined {
	if (host?.contained && !RUN_KEY.test(run))
		return "its key, which names its processes, is not a run's and a generation's";
	if (typeof host?.runDir !== "string" || !isAbsolute(host.runDir)) return "its directory is not an absolute path";
	if (host.pane !== undefined && !(typeof host.pane === "string" && RUN_PANE.test(host.pane))) {
		return "its pane is not named as a run's";
	}
	const { env } = host;
	if (typeof env !== "object" || env === null || Object.values(env).some((value) => typeof value !== "string")) {
		return "its environment is not a set of strings";
	}
	return undefined;
}

function saveForNextDaemon(store: RunQueueDeps["store"], runs: ActiveRun[]): boolean {
	try {
		store?.save(runs);
		return true;
	} catch {
		return false;
	}
}

export class RunQueue {
	private readonly entriesInClaimOrder = new Map<string, Entry>();
	private readonly served = new Map<string, number>();
	private sequence = 0;
	private capacity: number;
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly deps: RunQueueDeps;

	constructor(deps: RunQueueDeps) {
		this.deps = deps;
		this.capacity = deps.capacity() ?? DEFAULT_CAPACITY;
		for (const { run, parent, pid, contained } of deps.store?.load() ?? []) {
			if (!this.holdsSlot(pid, markerOf(run, contained))) continue;
			this.entriesInClaimOrder.set(run, { parent, state: "active", claimedAt: deps.now(), pid, contained });
		}
		if (this.entriesInClaimOrder.size > 0) this.schedule();
		this.save();
	}

	private holdsSlot(pid: number, marker: string | undefined): boolean {
		if (this.deps.running(pid)) return true;
		return marker !== undefined && this.deps.sweepStragglers(pid, marker) === "sweeping";
	}

	private save(): void {
		const active = [...this.entriesInClaimOrder].flatMap(([run, { parent, state, pid, contained }]) =>
			state === "active" && pid !== undefined ? [{ run, parent, pid, ...(contained ? { contained } : {}) }] : [],
		);
		saveForNextDaemon(this.deps.store, active);
	}

	claim(run: string, parent: string): Promise<boolean> {
		this.capacity = this.deps.capacity() ?? this.capacity;
		const now = this.deps.now();
		let entry = this.entriesInClaimOrder.get(run);
		if (!entry) {
			entry = { parent, state: "queued", claimedAt: now };
			this.entriesInClaimOrder.set(run, entry);
		}
		entry.claimedAt = now;
		if (entry.state !== "queued") return Promise.resolve(true);
		entry.answer?.(false);
		const claimed = entry;
		return new Promise((resolve) => {
			const timer = setTimeout(() => answer(false), RUN_CLAIM_WAIT_MS);
			const answer = (granted: boolean) => {
				clearTimeout(timer);
				if (claimed.answer === answer) claimed.answer = undefined;
				resolve(granted);
			};
			claimed.answer = answer;
			this.schedule();
		});
	}

	claimNow(run: string, parent: string): SlotClaim {
		this.capacity = this.deps.capacity() ?? this.capacity;
		this.check();
		const active = [...this.entriesInClaimOrder.values()].filter((entry) => entry.state !== "queued").length;
		if (this.entriesInClaimOrder.has(run)) return { granted: false, claimed: true, active, capacity: this.capacity };
		if (active >= this.capacity) return { granted: false, active, capacity: this.capacity };
		const now = this.deps.now();
		this.entriesInClaimOrder.set(run, { parent, state: "granted", claimedAt: now, grantedAt: now });
		this.served.set(parent, ++this.sequence);
		this.schedule();
		return { granted: true, active: active + 1, capacity: this.capacity };
	}

	launch(run: string, host: RunHostLaunch): number {
		const entry = this.entriesInClaimOrder.get(run);
		if (entry?.pid !== undefined) return entry.pid;
		if (entry?.state !== "granted") throw new Error(`run ${run} was not granted a slot`);
		const invalid = invalidLaunch(run, host);
		if (invalid) throw new Error(`run ${run} was not launched: ${invalid}`);
		if (host.pane) entry.pane = { name: host.pane, env: hostSafeEnv(host.env) };
		try {
			entry.pid = this.deps.spawn(host);
		} catch (error) {
			this.entriesInClaimOrder.delete(run);
			this.schedule();
			throw error;
		}
		entry.state = "active";
		entry.contained = host.contained === true;
		this.save();
		return entry.pid;
	}

	takePaneEnv(pane: string): Record<string, string> | undefined {
		for (const entry of this.entriesInClaimOrder.values()) {
			if (entry.pane?.name !== pane || !entry.pane.env) continue;
			const { env } = entry.pane;
			entry.pane.env = undefined;
			return env;
		}
		return undefined;
	}

	release(run: string): void {
		const entry = this.entriesInClaimOrder.get(run);
		if (!entry || entry.state === "active") return;
		this.entriesInClaimOrder.delete(run);
		entry.answer?.(false);
		this.schedule();
	}

	check(): void {
		const now = this.deps.now();
		let freed = false;
		for (const [run, entry] of this.entriesInClaimOrder) {
			const ended =
				entry.state === "active"
					? entry.pid === undefined || !this.holdsSlot(entry.pid, markerOf(run, entry.contained))
					: entry.state === "granted"
						? now - (entry.grantedAt ?? now) > LAUNCH_LEASE_MS
						: !entry.answer && now - entry.claimedAt > UNCLAIMED_MS;
			if (!ended) continue;
			this.entriesInClaimOrder.delete(run);
			freed ||= entry.state === "active";
		}
		if (freed) this.save();
		this.schedule();
	}

	stop(): void {
		clearInterval(this.timer);
		this.timer = undefined;
	}

	private schedule(): void {
		let held = [...this.entriesInClaimOrder.values()].filter((entry) => entry.state !== "queued").length;
		for (let next = this.next(); next && held < this.capacity; next = this.next()) {
			next.state = "granted";
			next.grantedAt = this.deps.now();
			this.served.set(next.parent, ++this.sequence);
			next.answer?.(true);
			held++;
		}
		if (this.entriesInClaimOrder.size === 0) this.stop();
		else if (!this.timer) {
			this.timer = setInterval(() => this.check(), CHECK_MS);
			this.timer.unref();
		}
	}

	private next(): Entry | undefined {
		let best: Entry | undefined;
		for (const entry of this.entriesInClaimOrder.values()) {
			if (entry.state !== "queued" || !entry.answer) continue;
			if (!best || (this.served.get(entry.parent) ?? 0) < (this.served.get(best.parent) ?? 0)) best = entry;
		}
		return best;
	}
}
