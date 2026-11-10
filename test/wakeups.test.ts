import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Context,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PARENT_ENV } from "../daemon/tmux.ts";
import backgroundBash from "../ext/background-bash/index.ts";
import { holdNotifications } from "../ext/background-bash/notification-hold.ts";
import { wakeupDue, wakeups } from "../ext/background-bash/wakeups.ts";
import { waitFor } from "./helpers/wait-for.ts";

/** 2026-11-10 13:30:00 local time. */
const NOW = new Date(2026, 10, 10, 13, 30, 0).getTime();
const MINUTE = 60_000;

const tempDirs: string[] = [];
const sessions: AgentSession[] = [];

afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
	for (const wakeup of wakeups.list()) wakeups.take(wakeup.id);
	vi.useRealTimers();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const textOf = (content: unknown) =>
	typeof content === "string"
		? content
		: (content as Array<{ type: string; text?: string }>).map((part) => part.text ?? "").join("\n");

/**
 * A pi session on a faux model with background-bash, its clock faked from 13:30 (and still moving, so pi's own
 * timers run). Each model call records the context it saw.
 */
async function startSession() {
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true, now: NOW });
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "bluclawd-wakeups-")));
	tempDirs.push(dir);
	const agentDir = join(dir, "agent");
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		modelsStorePath: join(agentDir, "models-store.json"),
		allowModelNetwork: false,
		refreshOnCreate: true,
	});
	const faux = fauxProvider({ provider: "faux-wakeups", models: [{ id: "faux-main" }] });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.refresh({ allowNetwork: false });
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir,
		agentDir,
		settingsManager,
		extensionFactories: [backgroundBash],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		disabledBuiltinExtensions: ["mcp", "codemode", "tool_search"],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir,
		modelRuntime,
		model: faux.getModel("faux-main"),
		thinkingLevel: "low",
		noTools: "builtin",
		resourceLoader,
		sessionManager: SessionManager.inMemory(dir),
		settingsManager,
	});
	sessions.push(session);
	await session.bindExtensions({ mode: "print" });
	const seen: Context[] = [];
	/** The model's replies, in order; each records the context it was called with. */
	const replies = (steps: FauxResponseStep[]) =>
		faux.setResponses(
			steps.map((step) => (context, options, state, model) => {
				seen.push(structuredClone(context));
				return typeof step === "function" ? step(context, options, state, model) : step;
			}),
		);
	return { session, replies, seen };
}

/** The text of the last message the model saw in `context`. */
const lastText = (context: Context) => textOf(context.messages.at(-1)?.content);

const call = (name: string, args: Record<string, string | number>) =>
	fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

describe("wakeupDue", () => {
	it("schedules a delay in seconds from now", () => {
		expect(wakeupDue({ delay: 600 }, NOW)).toEqual({ ok: true, dueAt: NOW + 10 * MINUTE });
	});

	it("schedules a clock time for its next occurrence: today, or tomorrow once past", () => {
		expect(wakeupDue({ at: "14:05" }, NOW)).toEqual({ ok: true, dueAt: new Date(2026, 10, 10, 14, 5).getTime() });
		expect(wakeupDue({ at: "9:15" }, NOW)).toEqual({ ok: true, dueAt: new Date(2026, 10, 11, 9, 15).getTime() });
	});

	it("refuses a wake-up under a minute or over 24 hours away", () => {
		expect(wakeupDue({ delay: 59 }, NOW)).toEqual({
			ok: false,
			error: "A wake-up must be due between 1 minute and 24 hours from now.",
		});
		expect(wakeupDue({ delay: 24 * 3600 + 1 }, NOW).ok).toBe(false);
		expect(wakeupDue({ delay: 24 * 3600 }, NOW).ok).toBe(true);
		expect(wakeupDue({ at: "13:30" }, NOW + 30_000).ok).toBe(true);
		expect(wakeupDue({ at: "13:31" }, NOW + 30_000).ok).toBe(false);
	});

	it("refuses both or neither of delay and at, counting empty fields as absent", () => {
		const error = "Give schedule_wakeup exactly one of delay or at.";
		expect(wakeupDue({ delay: 600, at: "14:05" }, NOW)).toEqual({ ok: false, error });
		expect(wakeupDue({}, NOW)).toEqual({ ok: false, error });
		expect(wakeupDue({ delay: 0, at: "" }, NOW)).toEqual({ ok: false, error });
		// Strict tool schemas fill every field.
		expect(wakeupDue({ delay: 0, at: "14:05" }, NOW).ok).toBe(true);
		expect(wakeupDue({ delay: 600, at: " " }, NOW).ok).toBe(true);
	});

	it("refuses a clock time it cannot read", () => {
		expect(wakeupDue({ at: "2pm" }, NOW)).toEqual({
			ok: false,
			error: 'Not a clock time: "2pm" (use 24-hour HH:MM, e.g. 14:05)',
		});
		expect(wakeupDue({ at: "24:00" }, NOW).ok).toBe(false);
	});
});

describe("schedule_wakeup", () => {
	it("schedules a wake-up that starts a turn with a notice, not a user message, when it falls due", async () => {
		const { session, replies, seen } = await startSession();
		replies([
			call("schedule_wakeup", { prompt: "Check whether CI on #278 went green.", delay: 600 }),
			fauxAssistantMessage("I'll check back at 13:40."),
			fauxAssistantMessage("CI is green."),
		]);
		await session.prompt("watch CI", { expandPromptTemplates: false });
		const result = lastText(seen[1]);
		const id = /\bw[0-9a-z]{8}\b/.exec(result)?.[0];
		expect(id).toBeDefined();
		expect(wakeups.list().map((w) => w.id)).toEqual([id]);

		vi.advanceTimersByTime(10 * MINUTE);
		await waitFor(() => seen.length === 3);
		const notice = lastText(seen[2]);
		expect(notice).toContain("NOT USER INPUT");
		expect(notice).toContain("Check whether CI on #278 went green.");
		expect(notice).toContain("13:40");
		expect(notice).toContain(`<task-id>${id}</task-id>`);
		const delivered = session.messages.at(-2);
		expect(delivered).toMatchObject({ role: "custom", customType: "bluclawd:wakeup" });
		expect(wakeups.list()).toEqual([]);
	});

	it("waits for the running turn to end, then starts the next one", async () => {
		const { session, replies, seen } = await startSession();
		replies([
			call("schedule_wakeup", { prompt: "Recheck the deploy.", delay: 60 }),
			() => {
				vi.advanceTimersByTime(MINUTE);
				return call("schedule_wakeup", { prompt: "Later.", delay: 3600 });
			},
			fauxAssistantMessage("Both scheduled."),
			fauxAssistantMessage("Deploy is fine."),
		]);
		await session.prompt("deploy", { expandPromptTemplates: false });
		await waitFor(() => seen.length === 4);
		// Not steered into the running turn: the call after it fell due saw no notice.
		expect(seen[2].messages.map((m) => textOf(m.content)).join("\n")).not.toContain("Recheck the deploy.");
		const last = seen[3].messages;
		expect(textOf(last.at(-2)?.content)).toBe("Both scheduled.");
		expect(textOf(last.at(-1)?.content)).toContain("Recheck the deploy.");
	});

	it("is held while /tasks is open, and starts its turn when it closes", async () => {
		const { session, replies, seen } = await startSession();
		replies([
			call("schedule_wakeup", { prompt: "Look at the monitor.", at: "13:45" }),
			fauxAssistantMessage("Scheduled."),
			fauxAssistantMessage("Looked."),
		]);
		await session.prompt("monitor", { expandPromptTemplates: false });
		const release = holdNotifications();
		try {
			vi.advanceTimersByTime(15 * MINUTE);
			// Proves nothing starts within it.
			await new Promise((r) => setTimeout(r, 200));
			expect(seen.length).toBe(2);
			expect(wakeups.list()).toHaveLength(1);
		} finally {
			release();
		}
		await waitFor(() => seen.length === 3);
		expect(lastText(seen[2])).toContain("Look at the monitor.");
	});

	it("is cancelled by task_stop and never fires", async () => {
		const { session, replies, seen } = await startSession();
		replies([
			call("schedule_wakeup", { prompt: "Never.", delay: 120 }),
			(context) => call("task_stop", { task_id: /\bw[0-9a-z]{8}\b/.exec(lastText(context))?.[0] ?? "" }),
			fauxAssistantMessage("Cancelled."),
		]);
		await session.prompt("cancel it", { expandPromptTemplates: false });
		expect(JSON.parse(lastText(seen[2]))).toMatchObject({ task_type: "wakeup" });
		expect(wakeups.list()).toEqual([]);
		vi.advanceTimersByTime(5 * MINUTE);
		// Proves nothing starts within it.
		await new Promise((r) => setTimeout(r, 200));
		expect(seen.length).toBe(3);
	});

	it("refuses a call outside its bounds, telling the model why", async () => {
		const { session, replies, seen } = await startSession();
		replies([call("schedule_wakeup", { prompt: "Too soon.", delay: 10 }), fauxAssistantMessage("Oh.")]);
		await session.prompt("soon", { expandPromptTemplates: false });
		expect(lastText(seen[1])).toContain("A wake-up must be due between 1 minute and 24 hours from now.");
		expect(wakeups.list()).toEqual([]);
	});

	it("is not given to a run", async () => {
		vi.stubEnv(PARENT_ENV, "orchestrator-pane");
		try {
			const { session } = await startSession();
			expect(session.getAllTools().map((tool) => tool.name)).not.toContain("schedule_wakeup");
			expect(session.getAllTools().map((tool) => tool.name)).toContain("task_stop");
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
