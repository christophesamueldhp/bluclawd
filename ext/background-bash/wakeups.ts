import type { SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { piCommand } from "../../daemon/tmux.ts";
import {
	cancelledByDelete,
	forgetCancelled,
	type HeldWakeups,
	isWakeupId,
	type ProcessId,
	pendingWakeupsOnAnyBranch,
	WAKEUP_END_ENTRY,
	WAKEUP_ENTRY,
	type WakeupEnd,
	type WakeupEndRecord,
	type WakeupRecord,
} from "../../daemon/wakeups.ts";
import { notifyListeners, sharedRef } from "../_shared/global-state.ts";
import { turnOnHint } from "../_shared/notice-once.ts";
import { randomTaskId } from "./background-bash.ts";
import { escapeXml, notificationContent, type OutgoingMessage, taskNotification } from "./monitor-events.ts";
import { deliverOrHold } from "./notification-hold.ts";

const MINUTE_MS = 60_000;
const MAX_AHEAD_MS = 24 * 60 * MINUTE_MS;

export type WakeupDue = { ok: true; dueAt: number } | { ok: false; error: string };

export function wakeupDue(input: { delay?: number; at?: string }, now: number): WakeupDue {
	const delay = typeof input.delay === "number" && input.delay !== 0 ? input.delay : undefined;
	const at = typeof input.at === "string" && input.at.trim() ? input.at.trim() : undefined;
	if ((delay === undefined) === (at === undefined)) {
		return { ok: false, error: "Give schedule_wakeup exactly one of delay or at." };
	}
	let dueAt: number;
	if (at !== undefined) {
		const clock = /^(\d{1,2}):(\d{2})$/.exec(at);
		const hours = Number(clock?.[1]);
		const minutes = Number(clock?.[2]);
		if (!clock || hours > 23 || minutes > 59) {
			return { ok: false, error: `Not a clock time: "${at}" (use 24-hour HH:MM, e.g. 14:05)` };
		}
		const today = new Date(now);
		const next = (days: number) =>
			new Date(today.getFullYear(), today.getMonth(), today.getDate() + days, hours, minutes).getTime();
		dueAt = next(0) > now ? next(0) : next(1);
	} else dueAt = now + (delay ?? 0) * 1000;
	if (dueAt - now < MINUTE_MS || (at === undefined && dueAt - now > MAX_AHEAD_MS)) {
		return { ok: false, error: "A wake-up must be due between 1 minute and 24 hours from now." };
	}
	return { ok: true, dueAt };
}

export { WAKEUP_END_ENTRY, WAKEUP_ENTRY, type WakeupRecord } from "../../daemon/wakeups.ts";

export const isWakeupTaskId = isWakeupId;

export interface Wakeup {
	id: string;
	owner: string | undefined;
	prompt: string;
	dueAt: number;
	scheduledAt: number;
}

interface Pending {
	wakeup: Wakeup;
	timer: ReturnType<typeof setTimeout>;
	onEnd: (wakeup: Wakeup, end: WakeupEnd) => void;
}

export class WakeupRegistry {
	private readonly pending = new Map<string, Pending>();
	private readonly listeners = new Set<() => void>();

	schedule(options: {
		owner: string | undefined;
		prompt: string;
		dueAt: number;
		restore?: Pick<Wakeup, "id" | "scheduledAt">;
		onDue: (wakeup: Wakeup) => void;
		onEnd: (wakeup: Wakeup, end: WakeupEnd) => void;
	}) {
		let id = options.restore?.id ?? randomTaskId("w");
		while (!options.restore && this.pending.has(id)) id = randomTaskId("w");
		const wakeup: Wakeup = {
			id,
			owner: options.owner,
			prompt: options.prompt,
			dueAt: options.dueAt,
			scheduledAt: options.restore?.scheduledAt ?? Date.now(),
		};
		const timer = setTimeout(() => options.onDue(wakeup), Math.max(0, options.dueAt - Date.now()));
		timer.unref();
		this.pending.set(id, { wakeup, timer, onEnd: options.onEnd });
		notifyListeners(this.listeners);
		return wakeup;
	}

	list(owner?: string): Wakeup[] {
		return [...this.pending.values()]
			.map((entry) => entry.wakeup)
			.filter((wakeup) => owner === undefined || wakeup.owner === owner)
			.sort((a, b) => a.dueAt - b.dueAt);
	}

	take(id: string, owner?: string, end: WakeupEnd = "cancelled"): Wakeup | undefined {
		const entry = this.pending.get(id);
		if (!entry || (owner !== undefined && entry.wakeup.owner !== owner)) return undefined;
		this.remove(entry);
		entry.onEnd(entry.wakeup, end);
		return entry.wakeup;
	}

	release(owner?: string): void {
		for (const entry of [...this.pending.values()]) {
			if (owner === undefined || entry.wakeup.owner === owner) this.remove(entry);
		}
	}

	private remove(entry: Pending): void {
		clearTimeout(entry.timer);
		this.pending.delete(entry.wakeup.id);
		notifyListeners(this.listeners);
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

export const wakeups = sharedRef("wakeups", new WakeupRegistry()).get();

export const WAKEUP_MESSAGE_TYPE = "bluclawd:wakeup";

export type WakeupMessageDetails = Pick<Wakeup, "id" | "prompt" | "dueAt">;

const pad = (n: number) => String(n).padStart(2, "0");

export function wakeupClock(at: number): string {
	const date = new Date(at);
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function wakeupDate(at: number): string {
	const date = new Date(at);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${wakeupClock(at)}`;
}

function wakeupMessage(wakeup: Wakeup, now: number): OutgoingMessage<WakeupMessageDetails> {
	const when =
		now - wakeup.dueAt < MINUTE_MS
			? `is due (due at ${wakeupDate(wakeup.dueAt)})`
			: `is late: it was due at ${wakeupDate(wakeup.dueAt)}, and it is now ${wakeupDate(now)}`;
	return {
		customType: WAKEUP_MESSAGE_TYPE,
		content: notificationContent(
			taskNotification({
				taskId: wakeup.id,
				status: "due",
				summary: `Your own wake-up, which you scheduled with schedule_wakeup, ${when}`,
				body: `\n<prompt>${escapeXml(wakeup.prompt)}</prompt>`,
			}),
		),
		display: true,
		details: { id: wakeup.id, prompt: wakeup.prompt, dueAt: wakeup.dueAt },
	};
}

export function wakeupToolOffNotice(count: number): string {
	const found = count === 1 ? "a pending wake-up: it still fires" : `${count} pending wake-ups: they still fire`;
	return `This session has ${found}, but schedule_wakeup is off by default now, so the agent cannot schedule another. ${turnOnHint("schedule_wakeup")}`;
}

export function wakeupScheduledText(wakeup: Wakeup): string {
	return `Wake-up ${wakeup.id} scheduled for ${wakeupDate(wakeup.dueAt)}. It starts a turn with its prompt then; cancel it with task_stop.`;
}

export interface WakeupSession {
	mode: string;
	isIdle(): boolean;
	sessionManager: {
		getSessionId(): string;
		getSessionFile(): string | undefined;
		getCwd(): string;
		getSessionName(): string | undefined;
		getEntries(): Parameters<typeof pendingWakeupsOnAnyBranch>[0];
	};
}

export interface WakeupDaemon {
	getDaemonInfo(): Promise<{ running: boolean; buildId?: string }>;
	restartDaemon(): Promise<unknown>;
	ensureDaemon(): Promise<unknown>;
	holdWakeups(held: HeldWakeups): Promise<void>;
}

interface WakeupLifecycleDeps {
	session: () => WakeupSession | undefined;
	append: (customType: string, data: WakeupRecord | WakeupEndRecord) => void;
	send: (message: OutgoingMessage<WakeupMessageDetails>) => void;
	daemon: () => WakeupDaemon;
	buildId: () => string;
	holder: () => ProcessId | undefined;
	now: () => number;
	killedBySignal: () => Promise<boolean>;
	log: (line: string) => void;
}

type ShutdownOutcome = "keep" | "cancel";

const AT_SHUTDOWN: Record<
	SessionShutdownEvent["reason"],
	(shutdown: {
		sameSession: boolean;
		killedBySignal: () => Promise<boolean>;
	}) => ShutdownOutcome | Promise<ShutdownOutcome>
> = {
	reload: () => "keep",
	resume: ({ sameSession }) => (sameSession ? "keep" : "cancel"),
	quit: async ({ killedBySignal }) => ((await killedBySignal()) ? "keep" : "cancel"),
	new: () => "cancel",
	fork: () => "cancel",
};

export function wakeupLifecycle(deps: WakeupLifecycleDeps) {
	const owner = () => deps.session()?.sessionManager.getSessionId();

	const dueWakeup = () => {
		const sessionId = owner();
		return sessionId === undefined ? undefined : wakeups.list(sessionId).find((wakeup) => wakeup.dueAt <= deps.now());
	};
	const fireDue = () => {
		if (!dueWakeup()) return;
		deliverOrHold(() => {
			const due = dueWakeup();
			if (!due || !deps.session()?.isIdle()) return;
			wakeups.take(due.id, undefined, "fired");
			deps.send(wakeupMessage(due, deps.now()));
		});
	};

	let handing = Promise.resolve();
	const handOff = () => {
		const session = deps.session();
		const sessionFile = session?.sessionManager.getSessionFile();
		const holder = deps.holder();
		if (session?.mode !== "tui" || !sessionFile || holder === undefined) return;
		const held: HeldWakeups = {
			sessionFile,
			cwd: session.sessionManager.getCwd(),
			label: session.sessionManager.getSessionName(),
			holder,
			launch: { command: piCommand() },
			wakeups: wakeups
				.list(session.sessionManager.getSessionId())
				.map(({ id, prompt, dueAt, scheduledAt }) => ({ id, prompt, dueAt, scheduledAt })),
		};
		handing = handing
			.then(async () => {
				const client = deps.daemon();
				const info = await client.getDaemonInfo();
				if (!info.running && held.wakeups.length === 0) return;
				if (info.running && info.buildId !== deps.buildId()) await client.restartDaemon();
				else if (!info.running) await client.ensureDaemon();
				await client.holdWakeups(held);
			})
			.catch(() => {});
	};

	const recordEnd = (wakeup: Pick<Wakeup, "id">, end: WakeupEnd) => {
		deps.append(WAKEUP_END_ENTRY, { id: wakeup.id, end });
		handOff();
	};

	const cancelAll = () => {
		const sessionId = owner();
		if (sessionId === undefined) return;
		for (const wakeup of wakeups.list(sessionId)) wakeups.take(wakeup.id, sessionId);
	};

	return {
		schedule(params: { prompt: string; delay?: number; at?: string }): Wakeup {
			const prompt = params.prompt.trim();
			if (!prompt) throw new Error("Missing required parameter: prompt");
			const due = wakeupDue(params, deps.now());
			if (!due.ok) throw new Error(due.error);
			const wakeup = wakeups.schedule({
				owner: owner(),
				prompt,
				dueAt: due.dueAt,
				onDue: fireDue,
				onEnd: recordEnd,
			});
			deps.append(WAKEUP_ENTRY, {
				id: wakeup.id,
				prompt,
				dueAt: wakeup.dueAt,
				scheduledAt: wakeup.scheduledAt,
			});
			handOff();
			return wakeup;
		},

		restore(reason: SessionStartEvent["reason"]): number {
			const session = deps.session();
			if (!session) return 0;
			const sessionId = session.sessionManager.getSessionId();
			const pending = pendingWakeupsOnAnyBranch(session.sessionManager.getEntries(), deps.log);
			for (const record of pending) {
				const deleted = cancelledByDelete(record.id);
				if (reason === "fork" || deleted) {
					recordEnd(record, "cancelled");
					if (deleted && reason !== "fork") forgetCancelled(record.id);
				} else {
					wakeups.schedule({
						owner: sessionId,
						prompt: record.prompt,
						dueAt: record.dueAt,
						restore: record,
						onDue: fireDue,
						onEnd: recordEnd,
					});
				}
			}
			const stored = wakeups.list(sessionId).length;
			if (stored > 0) handOff();
			return stored;
		},

		settled: fireDue,

		cancel: cancelAll,

		async shutdown(event: Pick<SessionShutdownEvent, "reason" | "targetSessionFile">): Promise<ShutdownOutcome> {
			const sessionId = owner();
			const outcome = await AT_SHUTDOWN[event.reason]({
				sameSession: event.targetSessionFile === deps.session()?.sessionManager.getSessionFile(),
				killedBySignal: deps.killedBySignal,
			});
			if (outcome === "cancel") cancelAll();
			else if (sessionId !== undefined) wakeups.release(sessionId);
			return outcome;
		},
	};
}
