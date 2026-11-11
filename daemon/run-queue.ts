/**
 * The daemon's queue of subagent runs on pi's RPC (ADR-0010): one bound on the runs active at once, shared by every
 * orchestrator of the daemon, and served fairly among them. An orchestrator claims a slot for its run and waits;
 * once granted, it checks that the run may still start and has the daemon launch the run's host, which the daemon
 * starts detached, as the orchestrator built it, and counts until every process of the host's group is gone. The
 * daemon never holds a run's stdio, and launches nothing its orchestrator does not claim: a queued run whose
 * orchestrator is gone waits, then is forgotten.
 */

/** How the daemon starts a run's host: everything it needs comes with it, the daemon's own environment unused. */
export interface RunHostLaunch {
	command: string[];
	env: Record<string, string>;
	cwd: string;
	/**
	 * For a run with a shell: the helper that finds and ends the processes its commands started, and the run's marker
	 * (ext/sandbox/run-containment.ts). They may have left the host's group, and its slot is held until they end too.
	 */
	contained?: { helper: string; marker: string };
}

/** How long a claim waits for a slot before it is answered without one; the orchestrator then claims again. */
export const RUN_CLAIM_WAIT_MS = 25_000;
/** How long a granted run's orchestrator has to launch it before its slot goes to another. */
const LAUNCH_LEASE_MS = 60_000;
/** How long a queued run no claim asked for is kept: its orchestrator is gone. */
const UNCLAIMED_MS = 2 * RUN_CLAIM_WAIT_MS;
/** How often launched runs are looked at, to free the slots of those that ended. */
const CHECK_MS = 200;
const DEFAULT_CAPACITY = 4;

export interface RunQueueDeps {
	now: () => number;
	/** Starts a run's host detached, in a process group of its own; returns its pid, or throws. */
	spawn: (launch: RunHostLaunch) => number;
	/**
	 * Whether any process of the group led by `pid` still runs, or, once none does, any process its commands started:
	 * those are ended then, since nothing of the run is left to own them.
	 */
	running: (pid: number, contained: RunHostLaunch["contained"]) => boolean;
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
	contained?: RunHostLaunch["contained"];
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
	contained?: RunHostLaunch["contained"];
}

export class RunQueue {
	/** In the order runs were first claimed, which each orchestrator's runs are served in. */
	private readonly entries = new Map<string, Entry>();
	/** When each orchestrator was last granted a slot, as a sequence: the least recently served goes first. */
	private readonly served = new Map<string, number>();
	private sequence = 0;
	private capacity = DEFAULT_CAPACITY;
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly deps: RunQueueDeps;

	constructor(deps: RunQueueDeps) {
		this.deps = deps;
		// Those still running when an earlier daemon ended hold their slots here, until their processes are gone.
		for (const { run, parent, pid, contained } of deps.store?.load() ?? []) {
			if (!deps.running(pid, contained)) continue;
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
	 * granted, false when {@link RUN_CLAIM_WAIT_MS} pass first. `capacity` is the user's setting, as the orchestrator
	 * read it: the last claim's applies.
	 */
	claim(run: string, parent: string, capacity: number): Promise<boolean> {
		this.capacity = Number.isInteger(capacity) && capacity > 0 ? capacity : DEFAULT_CAPACITY;
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
		try {
			entry.pid = this.deps.spawn(host);
		} catch (error) {
			this.entries.delete(run);
			this.schedule();
			throw error;
		}
		entry.state = "active";
		entry.contained = host.contained;
		this.save();
		return entry.pid;
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
					? entry.pid === undefined || !this.deps.running(entry.pid, entry.contained)
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
