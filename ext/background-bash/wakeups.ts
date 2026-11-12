/**
 * Wake-ups: turns an orchestrator's agent schedules for itself with `schedule_wakeup` (ADR-0009). Each pending
 * one is a task in `/tasks` and `task_stop`; it fires once, as a notice that starts the session's next turn.
 *
 * The session log owns a wake-up: it records each one being scheduled and ending (fired or cancelled), and the
 * pending ones are rebuilt from it when the session is opened. The registry holds the open session's, in memory
 * and process-wide like the jobs (`/tasks` is read from other extensions' module graphs).
 */

import type { WakeupEnd } from "../../daemon/wakeups.ts";
import { notifyListeners, sharedRef } from "../_shared/global-state.ts";
import { turnOnHint } from "../_shared/notice-once.ts";
import { randomTaskId } from "./background-bash.ts";
import { escapeXml, notificationContent, type OutgoingMessage, taskNotification } from "./monitor-events.ts";

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

export {
	pendingWakeups,
	WAKEUP_END_ENTRY,
	WAKEUP_ENTRY,
	type WakeupEnd,
	type WakeupEndRecord,
	type WakeupRecord,
} from "../../daemon/wakeups.ts";

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
export function wakeupMessage(wakeup: Wakeup, now: number): OutgoingMessage<WakeupMessageDetails> {
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
