import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type GenerationRecord,
	type GenerationWork,
	type PiLink,
	startGeneration,
} from "../ext/subagents/generation-protocol.ts";
import type { RpcHostSpec } from "../ext/subagents/rpc-host.ts";
import { openRunInbox, postToRun, readRunOutbox, sealedRunInbox } from "../ext/subagents/run-mailbox.ts";
import type { RunRuntimeOutcome } from "../ext/subagents/runs.ts";
import { readRunReports } from "../ext/subagents/storage.ts";
import { reportText } from "./helpers/run-files.ts";
import { waitFor } from "./helpers/wait-for.ts";

const MODEL = { provider: "faux", id: "faux-1", thinkingLevel: "off" };
const STARTED = { sessionId: "session-1", model: MODEL, thinkingLevel: "off" };

/**
 * pi in memory, the protocol's third adapter: what it is given starts its work, or steers it, and it works until told
 * to settle. As pi answers a prompt before its conversation holds it, a message is its conversation's only once `take`
 * says so.
 */
class MemoryPi implements PiLink {
	/** Everything it accepted, in order. */
	given: string[] = [];
	/** Given, not in its conversation yet. */
	queued: string[] = [];
	working = false;
	/** Its conversation holds what it accepts at once, as when pi's answer and its message_end come in one read. */
	eager = false;
	refuse?: (text: string) => boolean;
	/** Runs as the protocol asks whether it is quiet: its last look before the seal. */
	beforeSeal?: () => void;
	availableModels?: () => Promise<{ provider: string; id: string }[]>;
	work!: GenerationWork;

	async give(text: string): Promise<true | { refused?: string }> {
		if (this.refuse?.(text)) return { refused: `refused ${text}` };
		this.given.push(text);
		this.queued.push(text);
		this.working = true;
		if (this.eager) this.take();
		return true;
	}

	async quiet(): Promise<boolean> {
		this.beforeSeal?.();
		return !this.working && this.queued.length === 0;
	}

	/** Its conversation takes what it was given, at its next safe point. */
	take(): void {
		for (const text of this.queued.splice(0)) this.work.messageEnded({ role: "user", content: text });
	}

	/** It takes what it was given, answers, and its work settles. */
	async settle(text: string, ending: { stopReason?: string; errorMessage?: string } = {}): Promise<void> {
		this.take();
		this.work.messageEnded({ role: "assistant", content: [{ type: "text", text }], ...ending });
		this.working = false;
		await this.work.settled();
	}
}

/** Its run's directory and generation 0's inbox, open. */
let runDir: string;
let records: GenerationRecord[];
let endings: (RunRuntimeOutcome | undefined)[];

function start(
	spec: Partial<Pick<RpcHostSpec, "prompt" | "sessionFile" | "model">> = {},
	shape: (pi: MemoryPi) => void = () => {},
): MemoryPi {
	const pi = new MemoryPi();
	shape(pi);
	pi.work = startGeneration({
		runDir,
		spec: { generation: 0, prompt: "Look.", model: MODEL, ...spec },
		link: pi,
		save: (record) => records.push({ ...record }),
		ended: (outcome) => endings.push(outcome),
	});
	return pi;
}

const reports = () => readRunReports(runDir, 0);
const post = (text: string) => postToRun(runDir, 0, text);
const sealed = () => existsSync(sealedRunInbox(runDir, 0));

describe("a Generation's protocol, on pi in memory", () => {
	beforeEach(() => {
		runDir = mkdtempSync(join(tmpdir(), "bc-generation-"));
		openRunInbox(runDir, 0);
		records = [];
		endings = [];
	});
	afterEach(() => {
		rmSync(runDir, { recursive: true, force: true });
	});

	it("gives its task once started, and once its work settled stores the last answer as a completed Report", async () => {
		const pi = start();
		await pi.work.started({ ...STARTED, sessionFile: "/nowhere.jsonl" });
		expect(pi.given).toEqual(["Look."]);
		expect(records[0]).toEqual({ sessionFile: "/nowhere.jsonl", sessionId: "session-1" });

		await pi.settle("Looked.");
		expect(reports()).toEqual([
			{ seq: 1, text: "Looked.", outcome: { status: "completed" }, sessionId: "session-1", generation: 0 },
		]);
		expect(reportText(runDir, 1)).toBe("Looked.\n");
		expect(records.at(-1)).toMatchObject({ outcome: { status: "completed" }, reportSeq: 1 });
		expect(endings).toEqual([{ status: "completed" }]);
		expect(sealed()).toBe(true);
		expect(post("Too late.").accepted).toBe(false);
	});

	it.each([
		[
			{ stopReason: "error", errorMessage: "rate limited" },
			{ status: "failed", error: "rate limited" },
		],
		[{ stopReason: "error" }, { status: "failed", error: "its model failed" }],
		[{ stopReason: "aborted" }, { status: "stopped", error: "its work was stopped" }],
		[{ stopReason: "stop" }, { status: "completed" }],
	])("maps how its last answer ended, %o, to its outcome", async (ending, outcome) => {
		const pi = start();
		await pi.work.started(STARTED);
		await pi.settle("Answer.", ending);
		expect(endings).toEqual([outcome]);
		expect(reports()).toMatchObject([{ text: "Answer.", outcome }]);
	});

	it("fails before its task when pi opened another session, runs another model, or cannot use it", async () => {
		const session = start({ sessionFile: join(runDir, "run.jsonl") });
		await session.work.started({ ...STARTED, sessionFile: join(runDir, "other.jsonl") });
		expect(endings.at(-1)).toEqual({
			status: "failed",
			error: `its pi opened ${join(runDir, "other.jsonl")}, not the run's session ${join(runDir, "run.jsonl")}`,
		});
		expect(session.given).toEqual([]);

		const thinking = start();
		await thinking.work.started({ ...STARTED, thinkingLevel: "low" });
		expect(endings.at(-1)).toEqual({
			status: "failed",
			error: "its pi runs faux/faux-1 at thinking low, not faux/faux-1 at thinking off",
		});
		expect(thinking.given).toEqual([]);

		// Asked only of a link that can say, as pi's RPC can (#426).
		const unusable = start({}, (pi) => {
			pi.availableModels = async () => [{ provider: "faux", id: "other" }];
		});
		await unusable.work.started(STARTED);
		expect(endings.at(-1)).toEqual({
			status: "failed",
			error: "its pi cannot use faux/faux-1: the model is unknown to it, or it has no authentication for it",
		});
		expect(unusable.given).toEqual([]);
		const usable = start({}, (pi) => {
			pi.availableModels = async () => [{ provider: "faux", id: "faux-1" }];
		});
		await usable.work.started(STARTED);
		expect(usable.given).toEqual(["Look."]);
	});

	it("fails when pi refuses its task, with pi's reason when it gives one", async () => {
		const pi = start({}, (memory) => {
			memory.refuse = () => true;
		});
		await pi.work.started(STARTED);
		expect(endings).toEqual([{ status: "failed", error: "refused Look." }]);
		expect(reports()[0]).toMatchObject({ outcome: { status: "failed", error: "refused Look." } });
	});

	it("starts with no task, gives the first message posted, and ends with no Report when left before any", async () => {
		const pi = start({ prompt: "" });
		await pi.work.started(STARTED);
		expect(pi.given).toEqual([]);
		pi.work.end();
		expect(endings).toEqual([undefined]);
		expect(records.at(-1)).toMatchObject({ idle: true });
		expect(reports()).toEqual([]);
		expect(sealed()).toBe(true);

		rmSync(runDir, { recursive: true, force: true });
		openRunInbox(runDir, 0);
		const typedTo = start({ prompt: "" });
		await typedTo.work.started(STARTED);
		post("Also look for HERON.");
		await waitFor(() => expect(typedTo.given).toEqual(["Also look for HERON."]));
		await typedTo.settle("Found HERON.");
		expect(reports()).toMatchObject([{ text: "Found HERON.", outcome: { status: "completed" } }]);
	});

	it("does not settle while pi works, nor while its conversation does not hold a message it was given", async () => {
		const pi = start();
		await pi.work.started(STARTED);
		pi.take();
		post("Also look for HERON.");
		await waitFor(() => expect(pi.queued).toEqual(["Also look for HERON."]));
		pi.work.messageEnded({ role: "assistant", content: "Looked." });
		await pi.work.settled();
		expect(reports()).toEqual([]);

		// pi says it is idle with nothing queued, before its conversation holds the message: it goes on with it.
		pi.quiet = async () => true;
		await pi.work.settled();
		expect(reports()).toEqual([]);
		expect(sealed()).toBe(false);

		await pi.settle("Found HERON too.");
		expect(reports()).toMatchObject([{ text: "Found HERON too.", outcome: { status: "completed" } }]);
		expect(reports()[0].untaken).toBeUndefined();
		const marks = readdirSync(sealedRunInbox(runDir, 0)).filter((file) => file.endsWith(".given"));
		expect(marks).toHaveLength(1);
	});

	it.each([
		["later", false],
		["at once", true],
	])(
		"goes on with a message that landed just before the seal, its conversation holding it %s, and stores its Report once that work settles",
		async (_, eager) => {
			const pi = start();
			pi.eager = eager;
			await pi.work.started(STARTED);
			pi.beforeSeal = () => {
				pi.beforeSeal = undefined;
				post("One more: HERON.");
			};
			await pi.settle("Done.");
			expect(pi.given).toEqual(["Look.", "One more: HERON."]);
			expect(reports()).toEqual([]);
			// Open again for the work it goes on with.
			expect(sealed()).toBe(false);

			await pi.settle("Took HERON too.");
			expect(reports()).toMatchObject([{ seq: 1, text: "Took HERON too.", outcome: { status: "completed" } }]);
			expect(reports()[0].untaken).toBeUndefined();
		},
	);

	it("seals again and finishes when pi refuses every late message: they stay untaken", async () => {
		const pi = start({}, (memory) => {
			memory.refuse = (text) => text !== "Look.";
		});
		await pi.work.started(STARTED);
		pi.beforeSeal = () => {
			pi.beforeSeal = undefined;
			post("One more.");
			post("And another.");
		};
		await pi.settle("Done.");
		expect(reports()).toMatchObject([{ text: "Done.", outcome: { status: "completed" }, untaken: 2 }]);
		expect(sealed()).toBe(true);
		expect(post("After it.").accepted).toBe(false);
	});

	it("does not reopen its inbox when it is stopped while it looks whether pi is quiet", async () => {
		const pi = start();
		await pi.work.started(STARTED);
		pi.beforeSeal = () => {
			post("Landed late.");
			pi.work.stop();
		};
		await pi.settle("Done.");
		expect(sealed()).toBe(true);
		expect(post("After it.").accepted).toBe(false);
		expect(reports()).toEqual([]);
		pi.work.end({ status: "stopped", error: "its work was stopped" });
		expect(reports()).toMatchObject([{ outcome: { status: "stopped" }, untaken: 1 }]);
	});

	it("does not reopen its inbox when its work ends while it looks whether pi is quiet", async () => {
		const pi = start();
		await pi.work.started(STARTED);
		pi.beforeSeal = () => {
			post("Landed late.");
			pi.work.end({ status: "failed", error: "its pi exited first" });
		};
		await pi.settle("Done.");
		expect(endings).toEqual([{ status: "failed", error: "its pi exited first" }]);
		expect(reports()).toMatchObject([{ outcome: { status: "failed" }, untaken: 1 }]);
		expect(sealed()).toBe(true);
	});

	it("once stopped takes no more messages, and its Report counts those given but never taken", async () => {
		const pi = start();
		await pi.work.started(STARTED);
		pi.take();
		post("Also look for HERON.");
		await waitFor(() => expect(pi.queued).toEqual(["Also look for HERON."]));

		pi.work.stop();
		expect(post("Carry on.").accepted).toBe(false);
		// Its pi stops at its own pace: the Report comes with the end.
		expect(reports()).toEqual([]);
		pi.work.end({ status: "stopped", error: "its work was stopped" });
		expect(reports()).toMatchObject([{ outcome: { status: "stopped" }, untaken: 1 }]);
		const kept = readdirSync(sealedRunInbox(runDir, 0)).filter((file) => file.endsWith(".json"));
		expect(kept.map((file) => JSON.parse(readFileSync(join(sealedRunInbox(runDir, 0), file), "utf8")).text)).toEqual([
			"Also look for HERON.",
		]);
	});

	it("ends once: a later end or settle stores nothing more", async () => {
		const pi = start();
		await pi.work.started(STARTED);
		pi.work.end({ status: "failed", error: "its pi exited first" });
		pi.work.end({ status: "stopped", error: "its work was stopped" });
		await pi.settle("Late.");
		pi.work.end();
		expect(endings).toEqual([{ status: "failed", error: "its pi exited first" }]);
		expect(reports()).toHaveLength(1);
	});

	it("writes what the run sends out, and the notes its adapter adds, in one numbering", async () => {
		const pi = start();
		await pi.work.started(STARTED);
		const message = { to: "parent", kind: "finding", content: "HERON is in src/." };
		pi.work.toolEnded({ toolName: "subagent_message", isError: false, result: { details: message } });
		pi.work.send({ kind: "typed", text: "Also look in lib/." });
		// Not sent: refused by its tool, or another tool's.
		pi.work.toolEnded({ toolName: "subagent_message", isError: true, result: { details: message } });
		pi.work.toolEnded({ toolName: "read", isError: false, result: { details: message } });
		pi.work.toolEnded({ toolName: "subagent_message", isError: false, result: { details: message } });
		expect(readRunOutbox(runDir, 0, 0)).toEqual([
			{ ...message, seq: 1 },
			{ kind: "typed", text: "Also look in lib/.", seq: 2 },
			{ ...message, seq: 3 },
		]);
	});
});
