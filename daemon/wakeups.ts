import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PaneLaunch } from "./ipc/protocol.ts";
import { getServerDir } from "./paths.ts";
import { PS_TIMEOUT_MS, processAlive as pidAlive } from "./processes.ts";
import { loadWakeups, saveWakeups } from "./storage.ts";

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

export function isWakeupId(id: unknown): id is string {
	return typeof id === "string" && /^w[0-9a-z]{8}$/.test(id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWakeupRecord(value: unknown): value is WakeupRecord {
	return (
		isRecord(value) &&
		isWakeupId(value.id) &&
		typeof value.prompt === "string" &&
		typeof value.dueAt === "number" &&
		Number.isFinite(value.dueAt) &&
		typeof value.scheduledAt === "number" &&
		Number.isFinite(value.scheduledAt)
	);
}

function skippedWakeupLine(record: unknown): string {
	const id = isRecord(record) ? record.id : undefined;
	if (typeof id === "string" && !isWakeupId(id)) {
		return `Skipped a wake-up whose id bluclawd did not generate: ${JSON.stringify(id).slice(0, 80)}`;
	}
	return `Skipped a wake-up with a malformed record${typeof id === "string" ? `: ${id}` : ""}`;
}

function validWakeupRecords(records: readonly unknown[], log: (line: string) => void): WakeupRecord[] {
	return records.filter((record): record is WakeupRecord => {
		if (isWakeupRecord(record)) return true;
		log(skippedWakeupLine(record));
		return false;
	});
}

export function pendingWakeupsOnAnyBranch(entries: readonly unknown[], log: (line: string) => void): WakeupRecord[] {
	const ended = new Set<string>();
	const scheduled: WakeupRecord[] = [];
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "custom") continue;
		const { customType, data } = entry;
		if (customType === WAKEUP_END_ENTRY) {
			if (isRecord(data) && isWakeupId(data.id) && (data.end === "fired" || data.end === "cancelled")) {
				ended.add(data.id);
			} else log(skippedWakeupLine(data));
		} else if (customType === WAKEUP_ENTRY) {
			if (isWakeupRecord(data)) scheduled.push(data);
			else log(skippedWakeupLine(data));
		}
	}
	return scheduled.filter((record) => !ended.has(record.id)).sort((a, b) => a.dueAt - b.dueAt);
}

export function readPendingWakeups(file: string, log: (line: string) => void): WakeupRecord[] {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const entries = text.split("\n").flatMap((line): unknown[] => {
		try {
			return line ? [JSON.parse(line)] : [];
		} catch {
			return [];
		}
	});
	return pendingWakeupsOnAnyBranch(entries, log);
}

const cancelMark = (dir: string, id: string) => join(dir, "wakeups-cancelled", id);

export function markCancelled(dir: string, ids: readonly string[]): void {
	if (ids.length === 0) return;
	mkdirSync(join(dir, "wakeups-cancelled"), { recursive: true });
	for (const id of ids) if (isWakeupId(id)) writeFileSync(cancelMark(dir, id), "");
}

function cancelledForGood(dir: string, ids: readonly string[]): boolean {
	try {
		markCancelled(dir, ids);
		return true;
	} catch {
		return false;
	}
}

export function cancelledByDelete(id: string, dir: string = getServerDir()): boolean {
	return isWakeupId(id) && existsSync(cancelMark(dir, id));
}

export function forgetCancelled(id: string, dir: string = getServerDir()): void {
	if (isWakeupId(id)) rmSync(cancelMark(dir, id), { force: true });
}

export interface ProcessId {
	pid: number;
	startedAt: number;
}

export function processStart(pid: number): number | undefined {
	try {
		const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
			timeout: PS_TIMEOUT_MS,
		});
		const at = Date.parse(`${out.trim()} UTC`);
		return Number.isNaN(at) ? undefined : at;
	} catch {
		return undefined;
	}
}

const PS_LSTART_SLACK_MS = 1500;

export function processAlive({ pid, startedAt }: ProcessId): boolean {
	if (!pidAlive(pid)) return false;
	const at = processStart(pid);
	return at !== undefined && Math.abs(at - startedAt) < PS_LSTART_SLACK_MS;
}

export interface HeldWakeups {
	sessionFile: string;
	cwd: string;
	label?: string;
	holder: ProcessId;
	/** How to start pi again, as the holder was started. */
	launch?: PaneLaunch;
	wakeups: WakeupRecord[];
}

const RECHECK_MS = 30_000;
const REOPEN_WAIT_MS = 90_000;
const MAX_REOPENS = 3;

export interface WakeupKeeperDeps {
	dir: string;
	now: () => number;
	alive: (holder: ProcessId) => boolean;
	pending: typeof readPendingWakeups;
	reopen: (held: HeldWakeups) => unknown;
	log: (line: string) => void;
}

export class WakeupKeeper {
	private readonly held: Map<string, HeldWakeups>;
	private readonly reopened = new Map<string, { at: number; times: number }>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly deps: WakeupKeeperDeps;

	constructor(deps: WakeupKeeperDeps) {
		this.deps = deps;
		this.held = new Map(
			loadWakeups(deps.dir).flatMap((stored) => {
				const held = { ...stored, wakeups: validWakeupRecords(stored.wakeups, deps.log) };
				return held.wakeups.length > 0 ? [[held.sessionFile, held] as const] : [];
			}),
		);
	}

	hold(handed: HeldWakeups): void {
		const held = { ...handed, wakeups: validWakeupRecords(handed.wakeups, this.deps.log) };
		if (held.wakeups.length > 0) this.held.set(held.sessionFile, held);
		else this.held.delete(held.sessionFile);
		this.reopened.delete(held.sessionFile);
		this.saveOrRetryOnNextChange();
		this.check();
	}

	drop(sessionFile: string): void {
		const ids = [...this.pending(sessionFile), ...(this.held.get(sessionFile)?.wakeups ?? [])].map(({ id }) => id);
		cancelledForGood(this.deps.dir, ids);
		this.reopened.delete(sessionFile);
		if (this.held.delete(sessionFile)) this.saveOrRetryOnNextChange();
	}

	list(): HeldWakeups[] {
		return [...this.held.values()];
	}

	check(): void {
		const now = this.deps.now();
		let changed = false;
		for (const held of [...this.held.values()]) {
			if (!held.wakeups.some((wakeup) => wakeup.dueAt <= now) || this.deps.alive(held.holder)) continue;
			const last = this.reopened.get(held.sessionFile);
			if (last && now - last.at < REOPEN_WAIT_MS) continue;
			if (last && last.times >= MAX_REOPENS) {
				this.held.delete(held.sessionFile);
				this.reopened.delete(held.sessionFile);
				changed = true;
				continue;
			}
			const pending = this.pending(held.sessionFile).filter(
				(wakeup) => !cancelledByDelete(wakeup.id, this.deps.dir),
			);
			changed = true;
			if (pending.length === 0) {
				this.held.delete(held.sessionFile);
				continue;
			}
			this.held.set(held.sessionFile, { ...held, wakeups: pending });
			if (!pending.some((wakeup) => wakeup.dueAt <= now)) continue;
			this.reopened.set(held.sessionFile, { at: now, times: (last?.times ?? 0) + 1 });
			this.tryReopen(held);
		}
		if (changed) this.saveOrRetryOnNextChange();
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

	private pending(sessionFile: string): WakeupRecord[] {
		return validWakeupRecords(this.deps.pending(sessionFile, this.deps.log), this.deps.log);
	}

	private tryReopen(held: HeldWakeups): void {
		(async () => this.deps.reopen(held))().catch(() => undefined);
	}

	private saveOrRetryOnNextChange(): boolean {
		try {
			saveWakeups(this.deps.dir, this.list());
			return true;
		} catch {
			return false;
		}
	}
}
