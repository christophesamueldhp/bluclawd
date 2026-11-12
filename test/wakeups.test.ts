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
	type AgentSessionRuntime,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ExtensionUIContext,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PARENT_ENV } from "../daemon/tmux.ts";
import backgroundBash from "../ext/background-bash/index.ts";
import { heldNotifications, holdNotifications } from "../ext/background-bash/notification-hold.ts";
import { wakeupDue, wakeups } from "../ext/background-bash/wakeups.ts";
import { waitFor } from "./helpers/wait-for.ts";

/** 2026-11-10 13:30:00 local time. */
const NOW = new Date(2026, 10, 10, 13, 30, 0).getTime();
const MINUTE = 60_000;

const tempDirs: string[] = [];
const runtimes: AgentSessionRuntime[] = [];
let fauxProviders = 0;

afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.session.dispose();
	wakeups.release();
	vi.useRealTimers();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const textOf = (content: unknown) =>
	typeof content === "string"
		? content
		: (content as Array<{ type: string; text?: string }>).map((part) => part.text ?? "").join("\n");

/**
 * A pi on a faux model with background-bash, its session persisted under `dir` (a new one, or `sessionFile` opened
 * as pi started on it would). The clock is faked from 13:30 (and still moving, so pi's own timers run); a second
 * start in the same test keeps it. Each model call records the context it saw. Unless `wakeupTool` is false,
 * pi's `--tools +schedule_wakeup` turns the tool on. With `notices`, it has a UI, whose notices go there.
 */
async function startSession(
	options: {
		dir?: string;
		sessionFile?: string;
		provider?: string;
		lateAuth?: boolean;
		wakeupTool?: boolean;
		notices?: string[];
	} = {},
) {
	if (!vi.isFakeTimers()) {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true, now: NOW });
	}
	const dir = options.dir ?? realpathSync(mkdtempSync(join(tmpdir(), "bluclawd-wakeups-")));
	if (!options.dir) tempDirs.push(dir);
	const agentDir = join(dir, "agent");
	const sessionDir = join(dir, "sessions");
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		modelsStorePath: join(agentDir, "models-store.json"),
		allowModelNetwork: false,
		refreshOnCreate: true,
	});
	const faux = fauxProvider({
		provider: options.provider ?? `faux-wakeups-${++fauxProviders}`,
		models: [{ id: "faux-main" }],
	});
	// `lateAuth`: its auth is not checked yet when pi resumes the session, as an extension's provider may not be (#318).
	let authChecked = !options.lateAuth;
	if (options.lateAuth && faux.provider.auth.apiKey) {
		faux.provider.auth.apiKey.check = async () => (authChecked ? { type: "api_key", source: "test" } : undefined);
	}
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.refresh({ allowNetwork: false });
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const runtime = await createAgentSessionRuntime(
		async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				modelRuntime,
				settingsManager,
				resourceLoaderOptions: {
					extensionFactories: [backgroundBash],
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					disabledBuiltinExtensions: ["mcp", "codemode", "tool_search"],
				},
			});
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				// Resumed as pi resumes one on its own: the model the session recorded, if pi can restore it.
				model: options.lateAuth ? undefined : faux.getModel("faux-main"),
				thinkingLevel: "low",
				noTools: "builtin",
				tools: options.wakeupTool === false ? undefined : ["+schedule_wakeup"],
			});
			return { ...created, services, diagnostics: services.diagnostics };
		},
		{
			cwd: dir,
			agentDir,
			sessionManager: options.sessionFile
				? SessionManager.open(options.sessionFile, sessionDir)
				: SessionManager.create(dir, sessionDir),
		},
	);
	runtimes.push(runtime);
	authChecked = true;
	// As pi binds a session; without a binding a reload starts no new session.
	const notices = options.notices;
	// Any other UI call does nothing, and what it returns undoes nothing.
	const uiContext = notices
		? (new Proxy(
				{ notify: (message: string) => notices.push(message) },
				{ get: (target, key) => (target as Record<string | symbol, unknown>)[key] ?? (() => () => {}) },
			) as unknown as ExtensionUIContext)
		: undefined;
	const bind = (session: AgentSessionRuntime["session"]) =>
		session.bindExtensions({ mode: "print", uiContext, shutdownHandler: () => {} });
	runtime.setRebindSession(bind);
	await bind(runtime.session);
	const seen: Context[] = [];
	/** The model's replies, in order; each records the context it was called with. */
	const replies = (steps: FauxResponseStep[]) =>
		faux.setResponses(
			steps.map((step) => (context, options, state, model) => {
				seen.push(structuredClone(context));
				return typeof step === "function" ? step(context, options, state, model) : step;
			}),
		);
	return { runtime, session: runtime.session, replies, seen, dir };
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

	it("waits for the running turn to end, then starts the next one, even if the queue is cleared meanwhile", async () => {
		const { session, replies, seen } = await startSession();
		replies([
			call("schedule_wakeup", { prompt: "Recheck the deploy.", delay: 60 }),
			() => {
				vi.advanceTimersByTime(MINUTE);
				// As Esc does: pi's queued messages go back to the editor.
				session.clearQueue();
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

	it("holds nothing for /tasks when a turn ends with no wake-up due", async () => {
		const { session, replies } = await startSession();
		replies([fauxAssistantMessage("Nothing to do.")]);
		const release = holdNotifications();
		try {
			await session.prompt("hi", { expandPromptTemplates: false });
			expect(heldNotifications()).toBe(0);
		} finally {
			release();
		}
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

/** The id of the wake-up a schedule_wakeup result names. */
const wakeupId = (text: string) => /\bw[0-9a-z]{8}\b/.exec(text)?.[0];

/** The pi is gone without ending its session, as in a crash: nothing of it is left in this process. */
function crash(runtime: AgentSessionRuntime) {
	wakeups.release();
	runtime.session.dispose();
}

describe("a wake-up's lifetime", () => {
	it("stays pending across a reload and fires on time", async () => {
		const { session, replies, seen } = await startSession();
		replies([
			call("schedule_wakeup", { prompt: "Check the deploy.", delay: 600 }),
			fauxAssistantMessage("Scheduled."),
			fauxAssistantMessage("Deploy is fine."),
		]);
		await session.prompt("deploy", { expandPromptTemplates: false });
		const id = wakeupId(lastText(seen[1]));
		await session.reload();
		expect(wakeups.list().map((w) => w.id)).toEqual([id]);

		vi.advanceTimersByTime(10 * MINUTE);
		await waitFor(() => seen.length === 3);
		expect(lastText(seen[2])).toContain("Check the deploy.");
		expect(wakeups.list()).toEqual([]);
	});

	it("fires each one that fell due while the session was closed once it is reopened: late, in due order, each in its own turn", async () => {
		const first = await startSession();
		first.replies([
			call("schedule_wakeup", { prompt: "Second thing.", delay: 300 }),
			call("schedule_wakeup", { prompt: "First thing.", delay: 120 }),
			fauxAssistantMessage("Both scheduled."),
		]);
		await first.session.prompt("plan", { expandPromptTemplates: false });
		const sessionFile = first.session.sessionFile;
		crash(first.runtime);
		vi.setSystemTime(NOW + 60 * MINUTE);

		const reopened = await startSession({ dir: first.dir, sessionFile });
		reopened.replies([fauxAssistantMessage("Did the first."), fauxAssistantMessage("Did the second.")]);
		await waitFor(() => reopened.seen.length === 2);
		const firstNotice = lastText(reopened.seen[0]);
		expect(firstNotice).toContain("First thing.");
		expect(firstNotice).toContain("it was due at 2026-11-10 13:32");
		const second = reopened.seen[1].messages;
		expect(textOf(second.at(-2)?.content)).toBe("Did the first.");
		expect(textOf(second.at(-1)?.content)).toContain("Second thing.");
		expect(textOf(second.at(-1)?.content)).toContain("it was due at 2026-11-10 13:35");
		expect(wakeups.list()).toEqual([]);
	});

	it("fires, or is cancelled by task_stop, in a session reopened without schedule_wakeup", async () => {
		const first = await startSession();
		first.replies([
			call("schedule_wakeup", { prompt: "Check the deploy.", delay: 120 }),
			call("schedule_wakeup", { prompt: "Never.", delay: 600 }),
			fauxAssistantMessage("Scheduled."),
		]);
		await first.session.prompt("deploy", { expandPromptTemplates: false });
		const never = wakeupId(lastText(first.seen[2]));
		const sessionFile = first.session.sessionFile;
		crash(first.runtime);

		const reopened = await startSession({ dir: first.dir, sessionFile, wakeupTool: false });
		expect(reopened.session.getActiveToolNames()).not.toContain("schedule_wakeup");
		reopened.replies([call("task_stop", { task_id: never ?? "" }), fauxAssistantMessage("Cancelled.")]);
		await reopened.session.prompt("cancel it", { expandPromptTemplates: false });
		expect(lastText(reopened.seen[1])).toContain(`Successfully cancelled wake-up: ${never}`);

		reopened.replies([fauxAssistantMessage("Deploy is fine.")]);
		vi.advanceTimersByTime(2 * MINUTE);
		await waitFor(() => reopened.seen.length === 3);
		expect(lastText(reopened.seen[2])).toContain("Check the deploy.");
		expect(wakeups.list()).toEqual([]);
	});

	it("tells the user once, not the model, that a reopened session's wake-ups still fire without schedule_wakeup", async () => {
		vi.stubEnv(
			"PI_CODING_AGENT_DIR",
			join(realpathSync(mkdtempSync(join(tmpdir(), "bluclawd-wakeups-agent-"))), "agent"),
		);
		const first = await startSession({ notices: [] });
		first.replies([
			call("schedule_wakeup", { prompt: "Check the deploy.", delay: 600 }),
			fauxAssistantMessage("Ok."),
		]);
		await first.session.prompt("deploy", { expandPromptTemplates: false });
		const sessionFile = first.session.sessionFile;
		crash(first.runtime);

		const notices: string[] = [];
		const withTool = await startSession({ dir: first.dir, sessionFile, notices });
		expect(withTool.session.getActiveToolNames()).toContain("schedule_wakeup");
		crash(withTool.runtime);
		const empty = await startSession({ wakeupTool: false, notices });
		crash(empty.runtime);
		expect(notices).toEqual([]);

		const reopened = await startSession({ dir: first.dir, sessionFile, wakeupTool: false, notices });
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatch(/pending wake-up/);
		expect(notices[0]).toMatch(/still fires/);
		expect(notices[0]).toContain('"defaultTools": ["+schedule_wakeup"]');
		await reopened.session.reload();
		expect(notices).toHaveLength(1);
		reopened.replies([fauxAssistantMessage("Hi.")]);
		await reopened.session.prompt("hi", { expandPromptTemplates: false });
		expect(JSON.stringify(reopened.seen[0])).not.toMatch(/off by default/);
		crash(reopened.runtime);

		const again = await startSession({ dir: first.dir, sessionFile, wakeupTool: false, notices });
		expect(notices).toHaveLength(1);
		crash(again.runtime);
	});

	it("fires in the model the session recorded, though pi resumed it before that provider's auth was checked", async () => {
		const first = await startSession();
		first.replies([
			call("schedule_wakeup", { prompt: "Check the deploy.", delay: 120 }),
			fauxAssistantMessage("Scheduled."),
		]);
		await first.session.prompt("deploy", { expandPromptTemplates: false });
		const { sessionFile, model, thinkingLevel } = first.session;
		crash(first.runtime);
		vi.setSystemTime(NOW + 60 * MINUTE);

		const reopened = await startSession({ dir: first.dir, sessionFile, provider: model?.provider, lateAuth: true });
		reopened.replies([fauxAssistantMessage("Deploy is fine.")]);
		await waitFor(() => reopened.seen.length === 1);
		expect(lastText(reopened.seen[0])).toContain("Check the deploy.");
		expect(reopened.session.model).toMatchObject({ provider: model?.provider, id: model?.id });
		expect(reopened.session.thinkingLevel).toBe(thinkingLevel);
	});

	/** Another stored session, to `/resume`. */
	const otherSessionFile = (dir: string) => {
		const other = SessionManager.create(dir, join(dir, "sessions"));
		other.appendMessage({ role: "user", content: "other", timestamp: Date.now() });
		other.appendMessage(fauxAssistantMessage("Other."));
		return other.getSessionFile();
	};

	type Started = Awaited<ReturnType<typeof startSession>>;
	const endings: [string, (started: Started) => Promise<unknown>][] = [
		["a quit", ({ runtime }) => runtime.dispose()],
		["/new", ({ runtime }) => runtime.newSession()],
		["a /resume of another session", ({ runtime, dir }) => runtime.switchSession(otherSessionFile(dir) ?? "")],
		["a fork", ({ runtime }) => runtime.fork(runtime.session.sessionManager.getLeafId() ?? "", { position: "at" })],
		[
			"tree navigation",
			({ session }) =>
				session.navigateTree(session.sessionManager.getEntries().find((e) => e.type === "message")?.id ?? ""),
		],
	];

	it.each(endings)("is cancelled by %s, and a later /resume of the session revives none", async (_name, end) => {
		const started = await startSession();
		started.replies([call("schedule_wakeup", { prompt: "Never.", delay: 120 }), fauxAssistantMessage("Scheduled.")]);
		await started.session.prompt("later", { expandPromptTemplates: false });
		const sessionFile = started.session.sessionFile;
		await end(started);
		expect(wakeups.list()).toEqual([]);
		// A fork's new session has none either, now or reopened.
		const currentFile = started.runtime.session.sessionFile;
		crash(started.runtime);
		vi.setSystemTime(NOW + 60 * MINUTE);

		for (const file of new Set([sessionFile, currentFile])) {
			const reopened = await startSession({ dir: started.dir, sessionFile: file });
			expect(wakeups.list()).toEqual([]);
			// Proves nothing starts within it.
			await new Promise((r) => setTimeout(r, 200));
			expect(reopened.seen).toEqual([]);
			crash(reopened.runtime);
		}
	});

	it("never fires again once it has fired or been cancelled, after a reload or a reopen", async () => {
		const started = await startSession();
		started.replies([
			call("schedule_wakeup", { prompt: "Fires.", delay: 60 }),
			(context) =>
				call("schedule_wakeup", { prompt: `Cancelled after ${wakeupId(lastText(context))}.`, delay: 600 }),
			(context) => call("task_stop", { task_id: wakeupId(lastText(context)) ?? "" }),
			fauxAssistantMessage("One left."),
			fauxAssistantMessage("Fired."),
		]);
		await started.session.prompt("both", { expandPromptTemplates: false });
		vi.advanceTimersByTime(MINUTE);
		await waitFor(() => started.seen.length === 5);
		expect(lastText(started.seen[4])).toContain("Fires.");
		await started.session.reload();
		expect(wakeups.list()).toEqual([]);
		const sessionFile = started.session.sessionFile;
		crash(started.runtime);
		vi.setSystemTime(NOW + 60 * MINUTE);

		const reopened = await startSession({ dir: started.dir, sessionFile });
		expect(wakeups.list()).toEqual([]);
		// Proves nothing starts within it.
		await new Promise((r) => setTimeout(r, 200));
		expect(reopened.seen).toEqual([]);
	});
});
