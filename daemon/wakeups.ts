/**
 * Wake-ups as the daemon keeps them (ADR-0009). Each session's pi hands over its pending wake-ups, and the daemon
 * reopens the session in agent view's tmux to take one that falls due once that pi is gone; the reopened pi fires
 * it from its session log, late. The log stays the wake-ups' source of truth: it is read again before a reopen, so
 * a hand-off lost on the way (a quit's cancel) never reopens a session for nothing. A Delete's cancel, which no pi is
 * left to write there, is word left in the server dir instead.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PaneLaunch } from "./ipc/protocol.ts";
import { getServerDir } from "./paths.ts";
import { loadWakeups, saveWakeups } from "./storage.ts";

/** Session-log entries: a wake-up scheduled, and its end. */
export const WAKEUP_ENTRY = "bluclawd:wakeup-scheduled";
export const WAKEUP_END_ENTRY = "bluclawd:wakeup-end";

export interface WakeupRecord {
	id: string;
	prompt: string;
	dueAt: number;
	scheduledAt: number;
}

export type WakeupEnd = "fired" | "cancelled";

export interface WakeupEndRecord {
	id: string;
	end: WakeupEnd;
}

type Entry = { type: string; customType?: string; data?: unknown };

/** The wake-ups `entries` record scheduled and not ended, earliest first. Every branch counts: they are the session's. */
export function pendingWakeups(entries: readonly Entry[]): WakeupRecord[] {
	const ended = new Set<string>();
	const scheduled: WakeupRecord[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType === WAKEUP_END_ENTRY) ended.add((entry.data as WakeupEndRecord).id);
		else if (entry.customType === WAKEUP_ENTRY) scheduled.push(entry.data as WakeupRecord);
	}
	return scheduled.filter((record) => !ended.has(record.id)).sort((a, b) => a.dueAt - b.dueAt);
}

/** The pending wake-ups session file `file` records; none when it cannot be read. */
export function readPendingWakeups(file: string): WakeupRecord[] {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const entries = text.split("\n").flatMap((line): Entry[] => {
		try {
			return line ? [JSON.parse(line) as Entry] : [];
		} catch {
			return [];
		}
	});
	return pendingWakeups(entries);
}

/** Where a Delete leaves word that it cancelled wake-up `id`: the session log cannot record it, its pi being gone. */
const cancelMark = (dir: string, id: string) => join(dir, "wakeups-cancelled", id);

/** Leaves word that a Delete cancelled wake-ups `ids`, so neither the daemon nor a later `/resume` takes them. */
export function markCancelled(dir: string, ids: readonly string[]): void {
	if (ids.length === 0) return;
	mkdirSync(join(dir, "wakeups-cancelled"), { recursive: true });
	for (const id of ids) writeFileSync(cancelMark(dir, id), "");
}

/** Whether a Delete cancelled wake-up `id`. */
export function cancelledByDelete(id: string, dir: string = getServerDir()): boolean {
	return existsSync(cancelMark(dir, id));
}

/** Forgets that word once the session log records the cancel. */
export function forgetCancelled(id: string, dir: string = getServerDir()): void {
	rmSync(cancelMark(dir, id), { force: true });
}

/** A process, told apart from a later one given its pid (after a restart of the Mac) by when it started. */
export interface ProcessId {
	pid: number;
	startedAt: number;
}

/** When process `pid` started, to the second, as `ps` says; undefined once it is gone. */
export function processStart(pid: number): number | undefined {
	try {
		const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
			timeout: 2000,
		});
		// Printed in UTC, so the daemon and a pi with another TZ read the same time.
		const at = Date.parse(`${out.trim()} UTC`);
		return Number.isNaN(at) ? undefined : at;
	} catch {
		return undefined;
	}
}

/** Whether that process still runs. `ps` gives seconds, so a start within one of it is the same. */
export function processAlive({ pid, startedAt }: ProcessId): boolean {
	try {
		process.kill(pid, 0);
	} catch (error) {
		// EPERM: there is one, of another user, which is never a pi of this one's.
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
	}
	const at = processStart(pid);
	return at !== undefined && Math.abs(at - startedAt) < 1500;
}

/** What a pi hands over: its session's pending wake-ups, and which process holds them. */
export interface HeldWakeups {
	sessionFile: string;
	cwd: string;
	label?: string;
	holder: ProcessId;
	/** How to start pi again, as the holder was started. */
	launch?: PaneLaunch;
	wakeups: WakeupRecord[];
}

/** How often a due wake-up is looked at again: its pi may be gone since, and a timer runs late across a sleep. */
const RECHECK_MS = 30_000;
/** How long a reopened session has to take its pi, as a phone's start has (START_MS), before it is tried again. */
const REOPEN_WAIT_MS = 90_000;
/** How often a session is reopened for its wake-ups before the daemon gives up on it: its pi keeps failing to start. */
const MAX_REOPENS = 3;

export interface WakeupKeeperDeps {
	/** Where wakeups.json lives, and a Delete's word of the wake-ups it cancelled. */
	dir: string;
	now: () => number;
	alive: (holder: ProcessId) => boolean;
	/** The pending wake-ups a session's log records. */
	pending: (sessionFile: string) => WakeupRecord[];
	/** Reopens the session in agent view's tmux; throws or rejects when it cannot. */
	reopen: (held: HeldWakeups) => unknown;
}

/** The daemon's copy of every session's pending wake-ups, kept on disk across its restarts. */
export class WakeupKeeper {
	private readonly held: Map<string, HeldWakeups>;
	/** When each session was last reopened for a wake-up, and how often. */
	private readonly reopened = new Map<string, { at: number; times: number }>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly deps: WakeupKeeperDeps;

	constructor(deps: WakeupKeeperDeps) {
		this.deps = deps;
		this.held = new Map(loadWakeups(deps.dir).map((held) => [held.sessionFile, held]));
	}

	/** A pi's hand-over, which replaces what was held for its session: none pending, nothing is. */
	hold(held: HeldWakeups): void {
		if (held.wakeups.length > 0) this.held.set(held.sessionFile, held);
		else this.held.delete(held.sessionFile);
		this.reopened.delete(held.sessionFile);
		this.save();
		this.check();
	}

	/** Cancels a session's wake-ups, those its log has and those held: its row was deleted. */
	drop(sessionFile: string): void {
		const ids = [...this.deps.pending(sessionFile), ...(this.held.get(sessionFile)?.wakeups ?? [])].map(
			({ id }) => id,
		);
		try {
			markCancelled(this.deps.dir, ids);
		} catch {
			// Unmarked, they are only forgotten here: a later `/resume` revives them.
		}
		this.reopened.delete(sessionFile);
		if (this.held.delete(sessionFile)) this.save();
	}

	list(): HeldWakeups[] {
		return [...this.held.values()];
	}

	/** Reopens each session with a wake-up due whose pi is gone, then looks again when the next falls due. */
	check(): void {
		const now = this.deps.now();
		let changed = false;
		for (const held of [...this.held.values()]) {
			if (!held.wakeups.some((wakeup) => wakeup.dueAt <= now) || this.deps.alive(held.holder)) continue;
			const last = this.reopened.get(held.sessionFile);
			if (last && now - last.at < REOPEN_WAIT_MS) continue;
			// Its pi keeps failing to start: the log still has the wake-up, which fires, late, when the session is next opened.
			if (last && last.times >= MAX_REOPENS) {
				this.held.delete(held.sessionFile);
				this.reopened.delete(held.sessionFile);
				changed = true;
				continue;
			}
			// The session log has the last word: a fire or a cancel whose hand-off never came.
			const pending = this.deps
				.pending(held.sessionFile)
				.filter((wakeup) => !cancelledByDelete(wakeup.id, this.deps.dir));
			changed = true;
			if (pending.length === 0) {
				this.held.delete(held.sessionFile);
				continue;
			}
			this.held.set(held.sessionFile, { ...held, wakeups: pending });
			if (!pending.some((wakeup) => wakeup.dueAt <= now)) continue;
			this.reopened.set(held.sessionFile, { at: now, times: (last?.times ?? 0) + 1 });
			// One that cannot be reopened now is tried again once REOPEN_WAIT_MS has passed.
			try {
				Promise.resolve(this.deps.reopen(held)).catch(() => {});
			} catch {}
		}
		if (changed) this.save();
		this.arm(now);
	}

	stop(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	private arm(now: number): void {
		this.stop();
		const next = Math.min(...[...this.held.values()].flatMap((held) => held.wakeups.map((wakeup) => wakeup.dueAt)));
		if (!Number.isFinite(next)) return;
		this.timer = setTimeout(() => this.check(), next > now ? Math.min(next - now, RECHECK_MS) : RECHECK_MS);
		this.timer.unref();
	}

	private save(): void {
		try {
			saveWakeups(this.deps.dir, this.list());
		} catch {
			// Kept in memory; written again with the next change.
		}
	}
}
