/**
 * Wake-ups: turns an orchestrator's agent schedules for itself with `schedule_wakeup` (ADR-0009). Each pending
 * one is a task in `/tasks` and `task_stop`; it fires once, as a notice that starts the session's next turn.
 *
 * The session log owns a wake-up: it records each one being scheduled and ending (fired or cancelled), and the
 * pending ones are rebuilt from it when the session is opened. The registry holds the open session's, in memory
 * and process-wide like the jobs (`/tasks` is read from other extensions' module graphs).
 */

import { piCommand } from "../../daemon/tmux.ts";
import {
	cancelledByDelete,
	forgetCancelled,
	type HeldWakeups,
	type ProcessId,
	pendingWakeups,
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

/**
 * When a wake-up asked for with exactly one of `delay` (seconds) or `at` (a local `HH:MM`, its next occurrence)
 * falls due. Empty fields count as absent: models with strict tool schemas fill every field.
 */
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
	// A clock time's next occurrence is never refused for being too far: on a DST fall-back day it is 25 hours.
	if (dueAt - now < MINUTE_MS || (at === undefined && dueAt - now > MAX_AHEAD_MS)) {
		return { ok: false, error: "A wake-up must be due between 1 minute and 24 hours from now." };
	}
	return { ok: true, dueAt };
}

export { WAKEUP_END_ENTRY, WAKEUP_ENTRY, type WakeupRecord } from "../../daemon/wakeups.ts";

export function isWakeupTaskId(id: string): boolean {
	return /^w[0-9a-z]{8}$/.test(id);
}

export interface Wakeup {
	id: string;
	/** The session that scheduled it. */
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

/** The pending wake-ups. One leaves the list when it is cancelled or fires. */
export class WakeupRegistry {
	private readonly pending = new Map<string, Pending>();
	private readonly listeners = new Set<() => void>();

	/**
	 * `onDue` is called when it falls due; the wake-up stays pending until it is taken, and `onEnd` records how it
	 * ended. A `restore`d one, rebuilt from the session log, keeps its id and scheduling time.
	 */
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

	/** The owner's pending wake-ups (everyone's without one), earliest first. */
	list(owner?: string): Wakeup[] {
		return [...this.pending.values()]
			.map((entry) => entry.wakeup)
			.filter((wakeup) => owner === undefined || wakeup.owner === owner)
			.sort((a, b) => a.dueAt - b.dueAt);
	}

	/** Takes a pending wake-up off the list as it ends, cancelled unless it fires; undefined if it is not the owner's or not pending. */
	take(id: string, owner?: string, end: WakeupEnd = "cancelled"): Wakeup | undefined {
		const entry = this.pending.get(id);
		if (!entry || (owner !== undefined && entry.wakeup.owner !== owner)) return undefined;
		this.remove(entry);
		entry.onEnd(entry.wakeup, end);
		return entry.wakeup;
	}

	/** Lets go of the owner's wake-ups (everyone's without one) without ending them: they stay pending in the session log. */
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

/** `13:40`, local time. */
export function wakeupClock(at: number): string {
	const date = new Date(at);
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `2026-11-10 13:40`, local time. */
function wakeupDate(at: number): string {
	const date = new Date(at);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${wakeupClock(at)}`;
}

/** The notice that starts a wake-up's turn at `now`: the agent's own, with its due time and prompt. */
function wakeupMessage(wakeup: Wakeup, now: number): OutgoingMessage<WakeupMessageDetails> {
	// One a minute or more past due is called late, whatever held it up: a closed session, or a long turn.
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

/** What schedule_wakeup answers: the task id, and when it falls due. */
export function wakeupScheduledText(wakeup: Wakeup): string {
	return `Wake-up ${wakeup.id} scheduled for ${wakeupDate(wakeup.dueAt)}. It starts a turn with its prompt then; cancel it with task_stop.`;
}

/** The open session, as its wake-ups' lifecycle reads it: pi's extension context. */
export interface WakeupSession {
	mode: string;
	isIdle(): boolean;
	sessionManager: {
		getSessionId(): string;
		getSessionFile(): string | undefined;
		getCwd(): string;
		getSessionName(): string | undefined;
		getEntries(): Parameters<typeof pendingWakeups>[0];
	};
}

/** What a hand-off asks of the daemon's client. */
export interface WakeupDaemon {
	getDaemonInfo(): Promise<{ running: boolean; buildId?: string }>;
	restartDaemon(): Promise<unknown>;
	ensureDaemon(): Promise<unknown>;
	holdWakeups(held: HeldWakeups): Promise<void>;
}

interface WakeupLifecycleDeps {
	/** The open session; none before it starts or once it has shut down. */
	session: () => WakeupSession | undefined;
	/** Appends an entry to the session log. */
	append: (customType: string, data: WakeupRecord | WakeupEndRecord) => void;
	/** Sends the notice that starts a wake-up's turn. */
	send: (message: OutgoingMessage<WakeupMessageDetails>) => void;
	/** A client of the daemon, for one hand-off. */
	daemon: () => WakeupDaemon;
	/** This pi's build of the daemon: a running one of another build is replaced. */
	buildId: () => string;
	/** This pi's process, as the daemon tells it apart from a later one; undefined when it cannot be told. */
	holder: () => ProcessId | undefined;
	now: () => number;
	/** Whether pi was ended by a signal nobody asked for, which ADR-0009 counts as a crash. Asked only of a quit. */
	killedBySignal: () => Promise<boolean>;
}

/**
 * The pi side of one session instance's wake-ups (ADR-0009): scheduling and recording one, firing it once due and the
 * session idle, recording each end, restoring them from the log, handing the pending set to the daemon after every
 * change, and keeping or cancelling them at shutdown. Each of the session's entries in the registry leaves it at
 * shutdown, released or cancelled: it holds callbacks bound to this instance.
 */
export function wakeupLifecycle(deps: WakeupLifecycleDeps) {
	const owner = () => deps.session()?.sessionManager.getSessionId();

	const dueWakeup = () => {
		const session = owner();
		return session === undefined ? undefined : wakeups.list(session).find((wakeup) => wakeup.dueAt <= deps.now());
	};
	/**
	 * Starts the turn of the session's earliest due wake-up once the session is idle. Until then it stays pending,
	 * listed and cancellable, rather than in pi's queue, which Esc clears. A send held by `/tasks` checks again when it
	 * goes out.
	 */
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
	/**
	 * Hands the daemon the session's pending wake-ups each time they change, so it can take one for the session once
	 * this pi is gone. Sent in order; one lost on the way is made up for by the session log, which the daemon reads
	 * again before it acts. Only pi's TUI hands off: the daemon reopens a session in it.
	 */
	const handOff = () => {
		const session = deps.session();
		const sessionFile = session?.sessionManager.getSessionFile();
		const holder = deps.holder();
		if (session?.mode !== "tui" || !sessionFile || holder === undefined) return;
		// Taken now: by the time it is sent, a shutdown may have emptied the registry.
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
				// Scheduling one starts the daemon, as agent view does; one not running holds none to take back. One of an
				// older build is replaced, as agent view replaces it: it would not know a hand-off.
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
		const session = owner();
		if (session === undefined) return;
		for (const wakeup of wakeups.list(session)) wakeups.take(wakeup.id, session);
	};

	return {
		/** schedule_wakeup: schedules one, records it in the log and hands off; throws what the model is told. */
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

		/**
		 * At session start: the session's pending wake-ups, rebuilt from its log; overdue ones fall due at once. A fork's
		 * new session gets none: those it copied are recorded cancelled, so a later `/resume` of it revives none either.
		 * Nor do those a Delete cancelled, which the log records now. This pi holds the rest, and says so to the daemon,
		 * which leaves them to it while it runs. Returns how many it holds.
		 */
		restore(reason: "startup" | "reload" | "new" | "resume" | "fork"): number {
			const session = deps.session();
			if (!session) return 0;
			const id = session.sessionManager.getSessionId();
			for (const record of pendingWakeups(session.sessionManager.getEntries())) {
				const deleted = cancelledByDelete(record.id);
				if (reason === "fork" || deleted) {
					recordEnd(record, "cancelled");
					// A fork records it in its own log, not in the deleted session's.
					if (deleted && reason !== "fork") forgetCancelled(record.id);
				} else {
					wakeups.schedule({
						owner: id,
						prompt: record.prompt,
						dueAt: record.dueAt,
						restore: record,
						onDue: fireDue,
						onEnd: recordEnd,
					});
				}
			}
			const stored = wakeups.list(id).length;
			if (stored > 0) handOff();
			return stored;
		},

		/** The running turn has ended, and nothing else continues it: a due wake-up starts the next. */
		settled: fireDue,

		/** Cancels the session's wake-ups: tree navigation ends them. */
		cancel: cancelAll,

		/**
		 * At shutdown: a reload, or a `/resume` of the session itself, leaves its wake-ups pending for the next instance,
		 * and so does a crash, which a signal nobody sent counts as. Anything else ends the session and cancels them.
		 */
		async shutdown(event: {
			reason: "quit" | "reload" | "new" | "resume" | "fork";
			targetSessionFile?: string;
		}): Promise<"keep" | "cancel"> {
			const session = owner();
			const kept =
				event.reason === "reload" ||
				(event.reason === "resume" &&
					event.targetSessionFile === deps.session()?.sessionManager.getSessionFile()) ||
				(event.reason === "quit" && (await deps.killedBySignal()));
			if (!kept) cancelAll();
			else if (session !== undefined) wakeups.release(session);
			return kept ? "keep" : "cancel";
		},
	};
}
