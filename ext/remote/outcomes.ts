import { contentText } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PromptOutcome, RefusedReason } from "../../daemon/ipc/protocol.ts";
import { HEARTBEAT_MS } from "../agent-view/self-registration.ts";

export function refusal(
	message: { sessionFile?: string },
	session: { manualCompactionRunning: boolean; sessionFile?: string },
): RefusedReason | undefined {
	const sent = message.sessionFile;
	if (sent && sent !== session.sessionFile) return "session_changed";
	if (session.manualCompactionRunning) return "compacting";
	return undefined;
}

const OUTCOME_WINDOW = 20;

export const QUIET_HEARTBEATS_BEFORE_LOST = Math.ceil(30_000 / HEARTBEAT_MS);

type Looker = "input" | "settled" | "heartbeat";

interface Sent {
	id: string;
	text: string;
	seenInPiQueue?: boolean;
}

export class PromptOutcomes {
	private readonly awaitingInputEvent: Sent[] = [];
	private readonly queued: Sent[] = [];
	private readonly otherEntrantTexts: string[] = [];
	private readonly settled: PromptOutcome[] = [];
	private ctx: ExtensionContext | undefined;
	private quietLooks = 0;
	private manualCompactionRunning = false;
	private readonly report: (ctx: ExtensionContext) => Promise<void>;

	constructor(
		pi: Pick<ExtensionAPI, "on">,
		heartbeat: (look: () => void) => void,
		report: (ctx: ExtensionContext) => Promise<void>,
	) {
		this.report = report;
		pi.on("session_start", (_event, ctx) => {
			this.ctx = ctx;
		});
		pi.on("session_before_compact", (event) => {
			if (event.reason === "manual") this.manualCompactionRunning = true;
		});
		pi.on("session_compact", () => {
			this.manualCompactionRunning = false;
		});
		pi.on("session_compact_failed", () => {
			this.manualCompactionRunning = false;
		});
		pi.on("input", (event, ctx) => {
			if (!this.input(event)) return;
			void this.report(ctx);
			// pi queues it once every input handler is done, a tick later when none
			// awaits anything, and tells no extension.
			if (event.streamingBehavior) setTimeout(() => this.ctx && this.look(this.ctx, "input"), 0);
		});
		pi.on("message_start", (event, ctx) => {
			if (this.started(event.message)) void this.report(ctx);
		});
		pi.on("agent_settled", (_event, ctx) => this.look(ctx, "settled"));
		heartbeat(() => {
			if (this.ctx) this.look(this.ctx, "heartbeat");
		});
		pi.on("session_shutdown", async (event, ctx) => {
			this.ctx = undefined;
			if (event.reason !== "quit" && this.dropAllQueued()) await this.report(ctx);
		});
	}

	refusal(message: { sessionFile?: string }, sessionFile: string | undefined): RefusedReason | undefined {
		return refusal(message, { manualCompactionRunning: this.manualCompactionRunning, sessionFile });
	}

	sent(id: string, content: Parameters<typeof contentText>[0]): void {
		this.awaitingInputEvent.push({ id, text: contentText(content) });
		this.awaitingInputEvent.splice(0, this.awaitingInputEvent.length - OUTCOME_WINDOW);
	}

	private input(event: { text: string; source: string; streamingBehavior?: string }): boolean {
		const prompt = event.source === "extension" ? take(this.awaitingInputEvent, event.text) : undefined;
		if (!prompt) {
			if (event.streamingBehavior) {
				this.otherEntrantTexts.push(event.text);
				this.otherEntrantTexts.splice(0, this.otherEntrantTexts.length - OUTCOME_WINDOW);
			}
			return false;
		}
		if (event.streamingBehavior === "followUp") {
			this.queued.push(prompt);
			this.queued.splice(0, this.queued.length - OUTCOME_WINDOW);
			this.settle({ id: prompt.id, outcome: "queued" });
		} else this.settle({ id: prompt.id, outcome: "taken" });
		return true;
	}

	private started(message: { role: string; content?: unknown }): boolean {
		if (message.role !== "user") return false;
		const text = contentText(message.content as Parameters<typeof contentText>[0]);
		const prompt = take(this.queued, text);
		if (!prompt) {
			const at = this.otherEntrantTexts.indexOf(text);
			if (at >= 0) this.otherEntrantTexts.splice(at, 1);
			return false;
		}
		this.settle({ id: prompt.id, outcome: "taken" });
		return true;
	}

	private look(ctx: ExtensionContext, by: Looker): void {
		const pending = ctx.hasPendingMessages();
		const idle = ctx.isIdle();
		const quiet = !pending && idle;
		this.markLoneQueuedPromptSeen(pending);
		this.forgetEntrantsWhenQuiet(quiet);
		this.countQuietHeartbeat(quiet, by);
		if (quiet && this.dequeued(this.quietLooks)) void this.report(ctx);
	}

	private markLoneQueuedPromptSeen(pending: boolean): void {
		const [only] = this.queued;
		if (pending && only && this.queued.length === 1 && this.otherEntrantTexts.length === 0) only.seenInPiQueue = true;
	}

	private forgetEntrantsWhenQuiet(quiet: boolean): void {
		if (quiet) this.otherEntrantTexts.length = 0;
	}

	private countQuietHeartbeat(quiet: boolean, by: Looker): void {
		if (!quiet || by === "settled") this.quietLooks = 0;
		else if (by === "heartbeat") this.quietLooks++;
	}

	private dropAllQueued(): boolean {
		return this.dequeued(Number.POSITIVE_INFINITY);
	}

	private dequeued(quietLooks: number): boolean {
		const dropped = this.queued.filter(
			(prompt) => prompt.seenInPiQueue || quietLooks >= QUIET_HEARTBEATS_BEFORE_LOST,
		);
		for (const prompt of dropped) {
			this.queued.splice(this.queued.indexOf(prompt), 1);
			this.settle({ id: prompt.id, outcome: "lost", reason: "dequeued" });
		}
		return dropped.length > 0;
	}

	refused(id: string, reason: RefusedReason): void {
		this.settle({ id, outcome: "refused", reason });
	}

	slashCommandTaken(id: string): void {
		this.settle({ id, outcome: "taken" });
	}

	list(): PromptOutcome[] {
		return this.settled.map((outcome) => ({ ...outcome }));
	}

	private settle(outcome: PromptOutcome): void {
		const at = this.settled.findIndex((o) => o.id === outcome.id);
		if (at >= 0) this.settled[at] = outcome;
		else this.settled.push(outcome);
		this.settled.splice(0, this.settled.length - OUTCOME_WINDOW);
	}
}

function take(list: Sent[], text: string): Sent | undefined {
	const at = list.findIndex((p) => p.text === text);
	return at < 0 ? undefined : list.splice(at, 1)[0];
}
