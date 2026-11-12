/**
 * The daemon's queue of subagent runs on pi's RPC (ADR-0010): one bound on the runs active at once, shared by every
 * orchestrator of the daemon, and served fairly among them. An orchestrator claims a slot for its run and waits;
 * once granted, it checks that the run may still start and has the daemon launch the run's host, which the daemon
 * starts detached and counts until every process of the host's group is gone. The daemon starts its own host only,
 * from its own install: an orchestrator gives it the run's directory, whose spec the host reads and checks, and the
 * environment the run's pi gets. The daemon never holds a run's stdio, and launches nothing its orchestrator does
 * not claim: a queued run whose orchestrator is gone waits, then is forgotten.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { runMarker } from "./run-members.ts";

/**
 * What an orchestrator gives the daemon to start a run's host with. The environment is the orchestrator's, which the
 * run's pi gets, and travels in memory only, never to disk.
 */
export interface RunHostLaunch {
	runDir: string;
	env: Record<string, string>;
	/**
	 * For a run with a shell: the processes its commands started, which the daemon finds by the run's marker
	 * (daemon/run-members.ts), may have left the host's group, and its slot is held until they end too.
	 */
	contained?: boolean;
	/** The tmux session of agent view's server to start the host in, for a run in a pane (ADR-0013); else detached. */
	pane?: string;
}

/** What would have node, or the loader, run code of a client's choosing in a run's host or its pi. */
export const LOADER_ENV = ["NODE_OPTIONS", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD"];

/** The tmux session a run's generation runs in, when it runs in a pane: named after both, so it is found by them. */
export const runPaneSession = (runId: string, generation: number) => `${runId}-${generation}`;
const RUN_PANE = /^sub_[\w-]+-\d+$/;

/** How long a claim waits for a slot before it is answered without one; the orchestrator then claims again. */
export const RUN_CLAIM_WAIT_MS = 25_000;
/** How long a granted run's orchestrator has to launch it before its slot goes to another. */
const LAUNCH_LEASE_MS = 60_000;
/** How long a queued run no claim asked for is kept: its orchestrator is gone. */
const UNCLAIMED_MS = 2 * RUN_CLAIM_WAIT_MS;
/** How often launched runs are looked at, to free the slots of those that ended. */
const CHECK_MS = 200;
const DEFAULT_CAPACITY = 4;

/**
 * `subagents.maxActive` in the user's own settings, in agent dir `agentDir`: how many runs the daemon keeps active at
 * once. The daemon reads it itself, so neither a project's settings nor anything an orchestrator or its model sends
 * can raise it. Undefined while the settings cannot be read, as when their writer has written only part of them: a
 * failed read is no reason to raise the bound.
 */
export function maxActiveRuns(agentDir: string): number | undefined {
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
	/** Starts a run's host detached, or as its pane's command, in a process group of its own; returns its pid, or throws. */
	spawn: (launch: RunHostLaunch) => number;
	/**
	 * Whether any process of the group led by `pid` still runs, or, once none does, any process its commands started,
	 * found by the run's `marker`: those are ended then, since nothing of the run is left to own them.
	 */
	running: (pid: number, marker: string | undefined) => boolean;
	/** The user's bound on runs active at once, as it is now (maxActiveRuns); undefined keeps the bound last read. */
	capacity: () => number | undefined;
	/**
	 * Where the launched runs are kept for the daemon started next: their hosts outlive this one, and hold their slots
	 * until they end there too.
	 */
	store?: { load(): ActiveRun[]; save(runs: ActiveRun[]): void };
}

/** A launched run, as kept across daemons. */
export interface ActiveRun {
	run: string;
	parent: string;
	pid: number;
	contained?: boolean;
}

interface Entry {
	parent: string;
	state: "queued" | "granted" | "active";
	/** The claim waiting for a slot, if one is. */
	answer?: (granted: boolean) => void;
	/** When its orchestrator last claimed it. */
	claimedAt: number;
	grantedAt?: number;
	pid?: number;
	contained?: boolean;
	/** A run in a pane: its tmux session, and the environment its host has not taken yet. */
	pane?: { name: string; env?: Record<string, string> };
}

/** A run's key in the queue: its run ID and the generation launched. */
const RUN_KEY = /^(sub_[\w-]+)\/\d+$/;

/** The marker of run `run`'s processes, for a run with a shell. */
const markerOf = (run: string, contained: boolean | undefined) => {
	const runId = RUN_KEY.exec(run)?.[1];
	return contained && runId ? runMarker(runId) : undefined;
};

/** Why a launch is not one the daemon starts: what it was sent is a client's, unchecked by its type. */
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

export class RunQueue {
	/** In the order runs were first claimed, which each orchestrator's runs are served in. */
	private readonly entries = new Map<string, Entry>();
	/** When each orchestrator was last granted a slot, as a sequence: the least recently served goes first. */
	private readonly served = new Map<string, number>();
	private sequence = 0;
	private capacity: number;
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly deps: RunQueueDeps;

	constructor(deps: RunQueueDeps) {
		this.deps = deps;
		this.capacity = deps.capacity() ?? DEFAULT_CAPACITY;
		// Those still running when an earlier daemon ended hold their slots here, until their processes are gone.
		for (const { run, parent, pid, contained } of deps.store?.load() ?? []) {
			if (!deps.running(pid, markerOf(run, contained))) continue;
			this.entries.set(run, { parent, state: "active", claimedAt: deps.now(), pid, contained });
		}
		if (this.entries.size > 0) this.schedule();
		this.save();
	}

	private save(): void {
		const active = [...this.entries].flatMap(([run, { parent, state, pid, contained }]) =>
			state === "active" && pid !== undefined ? [{ run, parent, pid, ...(contained ? { contained } : {}) }] : [],
		);
		try {
			this.deps.store?.save(active);
		} catch {
			// Kept in memory: only a daemon started after this one would not count them.
		}
	}

	/**
	 * Claims a slot for run `run` of orchestrator `parent`, queuing it on its first claim. Resolves true once it is
	 * granted, false when {@link RUN_CLAIM_WAIT_MS} pass first. The user's bound is read again at each claim, so a
	 * change to it applies from the next.
	 */
	claim(run: string, parent: string): Promise<boolean> {
		this.capacity = this.deps.capacity() ?? this.capacity;
		const now = this.deps.now();
		let entry = this.entries.get(run);
		if (!entry) {
			entry = { parent, state: "queued", claimedAt: now };
			this.entries.set(run, entry);
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

	/** Launches granted run `run`'s host; returns its pid. A run launched already is not launched again. */
	launch(run: string, host: RunHostLaunch): number {
		const entry = this.entries.get(run);
		if (entry?.pid !== undefined) return entry.pid;
		if (entry?.state !== "granted") throw new Error(`run ${run} was not granted a slot`);
		const invalid = invalidLaunch(run, host);
		if (invalid) throw new Error(`run ${run} was not launched: ${invalid}`);
		// A host in a pane takes its environment from here once it runs, never through tmux's command line.
		if (host.pane) {
			const env = Object.entries(host.env).filter(([key]) => !LOADER_ENV.includes(key) && key !== "PI_PACKAGE_ROOT");
			entry.pane = { name: host.pane, env: Object.fromEntries(env) };
		}
		try {
			entry.pid = this.deps.spawn(host);
		} catch (error) {
			this.entries.delete(run);
			this.schedule();
			throw error;
		}
		entry.state = "active";
		entry.contained = host.contained === true;
		this.save();
		return entry.pid;
	}

	/**
	 * The environment the host started in pane `pane` was launched with, given once: whatever asks later, or asks for a
	 * pane no run launched, gets none.
	 */
	takePaneEnv(pane: string): Record<string, string> | undefined {
		for (const entry of this.entries.values()) {
			if (entry.pane?.name !== pane || !entry.pane.env) continue;
			const { env } = entry.pane;
			entry.pane.env = undefined;
			return env;
		}
		return undefined;
	}

	/** Gives up run `run`'s claim or slot before it launched; a launched run keeps its slot until its processes end. */
	release(run: string): void {
		const entry = this.entries.get(run);
		if (!entry || entry.state === "active") return;
		this.entries.delete(run);
		entry.answer?.(false);
		this.schedule();
	}

	/** Frees the slots of runs that ended, or were granted and never launched, then grants those freed. */
	check(): void {
		const now = this.deps.now();
		let freed = false;
		for (const [run, entry] of this.entries) {
			const ended =
				entry.state === "active"
					? entry.pid === undefined || !this.deps.running(entry.pid, markerOf(run, entry.contained))
					: entry.state === "granted"
						? now - (entry.grantedAt ?? now) > LAUNCH_LEASE_MS
						: !entry.answer && now - entry.claimedAt > UNCLAIMED_MS;
			if (!ended) continue;
			this.entries.delete(run);
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
		let held = [...this.entries.values()].filter((entry) => entry.state !== "queued").length;
		for (let next = this.next(); next && held < this.capacity; next = this.next()) {
			next.state = "granted";
			next.grantedAt = this.deps.now();
			this.served.set(next.parent, ++this.sequence);
			next.answer?.(true);
			held++;
		}
		if (this.entries.size === 0) this.stop();
		else if (!this.timer) {
			this.timer = setInterval(() => this.check(), CHECK_MS);
			this.timer.unref();
		}
	}

	/** The next run to grant: the first claimed of the orchestrator least recently served. */
	private next(): Entry | undefined {
		let best: Entry | undefined;
		for (const entry of this.entries.values()) {
			if (entry.state !== "queued" || !entry.answer) continue;
			if (!best || (this.served.get(entry.parent) ?? 0) < (this.served.get(best.parent) ?? 0)) best = entry;
		}
		return best;
	}
}
