import { describe, expect, it } from "vitest";
import type { InstanceSummary, PaneReport } from "../daemon/ipc/protocol.ts";
import {
	decide,
	type PhoneAction,
	type PhoneOutcome,
	type PhoneSession,
	phoneSession,
	type Transcript,
} from "../daemon/remote/phone-control.ts";

const opus = { provider: "anthropic", id: "claude-opus", name: "Opus" };
const gpt = { provider: "openai", id: "gpt-5", name: "GPT-5" };
const png = { mimeType: "image/png" as const, data: "iVBORw0KGgoBAQEB" };

const pane = (id: string, extra: Partial<InstanceSummary> = {}): InstanceSummary => ({
	id,
	status: "online",
	cwd: "/p",
	external: true,
	activity: "idle",
	sessionFile: `/s/${id}.jsonl`,
	pane: `pi-${id}`,
	leafId: "cccccccc",
	...extra,
});

/** As a current pane reports itself: everything a phone action may need. */
const full: PaneReport = {
	model: opus,
	models: [opus, gpt],
	thinkingLevels: ["off", "low", "medium", "high"],
	trust: "always",
	// As an older pane may list them too: pi's own selector, and an extension's command, which phoneMayRun refuses.
	commands: [
		{ name: "compact", source: "builtin" },
		{ name: "skill:pdf", source: "skill" },
		{ name: "settings", source: "builtin" },
		{ name: "tasks", source: "extension" },
	],
	tasks: [
		{ id: "b1", kind: "shell", label: "npm run dev", startedAt: 1, outputFile: "/tmp/b1.output" },
		{ id: "f2", kind: "shell", label: "sleep 60", startedAt: 2, foreground: true },
	],
};

const instances: InstanceSummary[] = [
	pane("running"),
	{ id: "stopped", status: "stopped", cwd: "/p", sessionFile: "/s/stopped.jsonl" },
	pane("old"),
	pane("bare"),
	pane("busy", { activity: "working" }),
	pane("drafting", { draft: true }),
];
const reports = new Map<string, PaneReport>([
	["running", full],
	// A pane from before trust, thinking levels, commands and tasks were reported.
	["old", { model: opus, models: [opus, gpt] }],
	["busy", full],
	["drafting", full],
]);
const deps = { listInstances: () => instances, report: (id: string) => reports.get(id) };

function session(id: string): PhoneSession {
	const found = phoneSession(deps, id);
	if (!found) throw new Error(`no session ${id}`);
	return found;
}

const message = (m: Extract<PhoneOutcome, { message: unknown }>["message"]): PhoneOutcome => ({ message: m });
const error = (code: Extract<PhoneOutcome, { error: unknown }>["error"]): PhoneOutcome => ({ error: code });
const operation = (o: Extract<PhoneOutcome, { operation: unknown }>["operation"]): PhoneOutcome => ({ operation: o });

type Row = [
	label: string,
	action: PhoneAction,
	running: PhoneOutcome,
	stopped: PhoneOutcome,
	old: PhoneOutcome,
	bare: PhoneOutcome,
];

const notRunning = error("session_not_running");
const tooOld = error("pane_too_old");

// Each action across a running pane, a stored row, a pane too old to report the newer fields, and one that sent no report.
const rows: Row[] = [
	["a prompt", { type: "prompt", text: "next" }, ...four(message({ type: "prompt", text: "next" }), notRunning)],
	[
		"a prompt with images",
		{ type: "prompt", text: "look", images: [png] },
		...four(message({ type: "prompt", text: "look", images: [png] }), notRunning),
	],
	[
		"a listed command",
		{ type: "prompt", text: "/compact keep the notes" },
		message({ type: "command", text: "/compact keep the notes" }),
		error("command_refused"),
		error("command_refused"),
		error("command_refused"),
	],
	[
		"a listed skill",
		{ type: "prompt", text: "  /skill:pdf report.pdf" },
		message({ type: "command", text: "  /skill:pdf report.pdf" }),
		error("command_refused"),
		error("command_refused"),
		error("command_refused"),
	],
	...["/settings", "/tasks", "/remote-control pair", "/agent-view", "/tree", "/fork", "/model"].map(
		(text): Row => [`the Mac-only ${text}`, { type: "prompt", text }, ...all(error("command_refused"))],
	),
	[
		"a slash line with images",
		{ type: "prompt", text: "/describe", images: [png] },
		...four(message({ type: "prompt", text: "/describe", images: [png] }), notRunning),
	],
	[
		"text that starts with a path",
		{ type: "prompt", text: "/Users/me/notes.md says hi" },
		...four(message({ type: "prompt", text: "/Users/me/notes.md says hi" }), notRunning),
	],
	[
		"a `!` line",
		{ type: "prompt", text: "!ls -la" },
		...four(message({ type: "command", text: "!ls -la" }), notRunning),
	],
	["a lone `!`", { type: "prompt", text: "!" }, ...four(message({ type: "prompt", text: "!" }), notRunning)],
	["an abort", { type: "abort" }, ...four(message({ type: "abort" }), notRunning)],
	[
		"an offered model",
		{ type: "model", provider: "openai", id: "gpt-5" },
		message({ type: "set_model", provider: "openai", id: "gpt-5" }),
		notRunning,
		message({ type: "set_model", provider: "openai", id: "gpt-5" }),
		tooOld,
	],
	[
		"a model not offered",
		{ type: "model", provider: "openai", id: "gpt-4" },
		error("invalid_model"),
		notRunning,
		error("invalid_model"),
		tooOld,
	],
	...[{}, { provider: "openai" }, { provider: "", id: "gpt-5" }, { provider: 1, id: "gpt-5" }].map(
		(body): Row => [
			`a malformed model ${JSON.stringify(body)}`,
			{ type: "model", provider: undefined, id: undefined, ...body },
			error("invalid_model"),
			error("invalid_model"),
			error("invalid_model"),
			tooOld,
		],
	),
	[
		"an offered thinking level",
		{ type: "thinking", level: "low" },
		message({ type: "set_thinking", level: "low" }),
		notRunning,
		error("invalid_thinking"),
		tooOld,
	],
	...[undefined, 3, "xhigh", ""].map(
		(level): Row => [
			`the thinking level ${JSON.stringify(level)}`,
			{ type: "thinking", level },
			error("invalid_thinking"),
			notRunning,
			error("invalid_thinking"),
			tooOld,
		],
	),
	[
		"a trust mode",
		{ type: "trust", trust: "ask" },
		message({ type: "set_trust", trust: "ask" }),
		notRunning,
		tooOld,
		tooOld,
	],
	...[undefined, "sometimes", ["ask"], "ASK"].map(
		(trust): Row => [
			`the trust mode ${JSON.stringify(trust)}`,
			{ type: "trust", trust },
			error("invalid_trust"),
			notRunning,
			error("invalid_trust"),
			tooOld,
		],
	),
	[
		"a rename",
		{ type: "rename", name: "  fix the build  " },
		message({ type: "rename", name: "fix the build" }),
		operation({ type: "rename", name: "fix the build" }),
		message({ type: "rename", name: "fix the build" }),
		message({ type: "rename", name: "fix the build" }),
	],
	[
		"a 100-character name",
		{ type: "rename", name: "x".repeat(100) },
		message({ type: "rename", name: "x".repeat(100) }),
		operation({ type: "rename", name: "x".repeat(100) }),
		message({ type: "rename", name: "x".repeat(100) }),
		message({ type: "rename", name: "x".repeat(100) }),
	],
	...[undefined, 7, "   ", "x".repeat(101), "a\nb", `${String.fromCharCode(27)}[31mred`].map(
		(name): Row => [`the name ${JSON.stringify(name)}`, { type: "rename", name }, ...all(error("invalid_name"))],
	),
	["a pin", { type: "pin", pinned: true }, ...all(operation({ type: "pin", pinned: true }))],
	["an unpin", { type: "pin", pinned: false }, ...all(operation({ type: "pin", pinned: false }))],
	...[undefined, "true", 1].map(
		(pinned): Row => [`the pin ${JSON.stringify(pinned)}`, { type: "pin", pinned }, ...all(error("invalid_pinned"))],
	),
	[
		"a delete",
		{ type: "delete" },
		error("session_running"),
		operation({ type: "delete" }),
		error("session_running"),
		error("session_running"),
	],
	[
		"stopping a reported task",
		{ type: "stop_task", taskId: "f2" },
		message({ type: "stop_task", id: "f2" }),
		error("unknown_task"),
		error("unknown_task"),
		error("unknown_task"),
	],
	["stopping an unknown task", { type: "stop_task", taskId: "b9" }, ...all(error("unknown_task"))],
	[
		"a task's output",
		{ type: "task_output", taskId: "b1" },
		{ read: { type: "task_output", file: "/tmp/b1.output" } },
		error("unknown_task"),
		error("unknown_task"),
		error("unknown_task"),
	],
	[
		"the output of a task that writes none",
		{ type: "task_output", taskId: "f2" },
		error("no_output"),
		error("unknown_task"),
		error("unknown_task"),
		error("unknown_task"),
	],
	["an unknown task's output", { type: "task_output", taskId: "b9" }, ...all(error("unknown_task"))],
	[
		"a transcript image",
		{ type: "image", entryId: "aaaaaaaa", index: 1 },
		...each((transcript) => ({ read: { type: "image", transcript, entryId: "aaaaaaaa", index: 1 } })),
	],
	[
		"a tool result's whole output",
		{ type: "message_output", entryId: "aaaaaaaa" },
		...each((transcript) => ({ read: { type: "message_output", transcript, entryId: "aaaaaaaa" } })),
	],
	[
		"the status",
		{ type: "status" },
		{
			// No commands, which have their own route; a task's output file stays on the Mac.
			status: {
				model: opus,
				models: [opus, gpt],
				thinkingLevels: ["off", "low", "medium", "high"],
				trust: "always",
				tasks: [
					{ id: "b1", kind: "shell", label: "npm run dev", startedAt: 1, output: true },
					{ id: "f2", kind: "shell", label: "sleep 60", startedAt: 2, foreground: true },
				],
			},
		},
		error("no_status"),
		{ status: { model: opus, models: [opus, gpt] } },
		error("no_status"),
	],
	[
		"the commands",
		{ type: "commands" },
		{ commands: full.commands ?? [] },
		error("no_status"),
		{ commands: [] },
		error("no_status"),
	],
];

/** The same outcome for each running pane, `stopped` for the stored row. */
function four(running: PhoneOutcome, stopped: PhoneOutcome): [PhoneOutcome, PhoneOutcome, PhoneOutcome, PhoneOutcome] {
	return [running, stopped, running, running];
}
function all(outcome: PhoneOutcome): [PhoneOutcome, PhoneOutcome, PhoneOutcome, PhoneOutcome] {
	return [outcome, outcome, outcome, outcome];
}
/** Read from each session's own file, at its pane's leaf (a stored row has none). */
function each(
	read: (transcript: Transcript) => PhoneOutcome,
): [PhoneOutcome, PhoneOutcome, PhoneOutcome, PhoneOutcome] {
	const at = (id: string, leafId?: string): Transcript => ({ sessionFile: `/s/${id}.jsonl`, leafId });
	return [
		read(at("running", "cccccccc")),
		read(at("stopped")),
		read(at("old", "cccccccc")),
		read(at("bare", "cccccccc")),
	];
}

describe("phone control", () => {
	describe.each([
		["a running pane", "running", 2],
		["a stored row", "stopped", 3],
		["a pane too old to report the newer fields", "old", 4],
		["a pane that sent no report", "bare", 5],
	] as const)("for %s", (_, id, column) => {
		it.each(rows.map((row) => [row[0], row[1], row[column]] as const))("%s", (_label, action, expected) => {
			expect(decide(session(id), action)).toEqual(expected);
		});
	});

	describe("a command or `!` line, which goes only into an idle, empty prompt", () => {
		it.each([
			["/compact", "busy", error("session_busy")],
			["!ls", "busy", error("session_busy")],
			["/compact", "drafting", error("unsent_draft")],
			["!ls", "drafting", error("unsent_draft")],
			// Text is no command: neither a turn nor a draft holds it up.
			["compact it", "busy", message({ type: "prompt", text: "compact it" })],
			["compact it", "drafting", message({ type: "prompt", text: "compact it" })],
		] as const)("%s to the %s session", (text, id, expected) => {
			expect(decide(session(id), { type: "prompt", text })).toEqual(expected);
		});
	});

	it("shows only the status fields it declares, never a new one a pane reports", () => {
		const newer = { ...full, pistatusline: { worker: "/w.js", config: "/c.json" }, somethingNew: 1 } as PaneReport;
		const status = decide({ ...session("running"), report: newer }, { type: "status" });
		expect(status).toHaveProperty("status.model", opus);
		expect(status).not.toHaveProperty("status.somethingNew");
		expect(status).not.toHaveProperty("status.pistatusline");
	});

	it("shows none of a stored row's last report", () => {
		expect(decide({ ...session("stopped"), report: full }, { type: "status" })).toEqual(error("no_status"));
	});

	it("knows no session that is not listed", () => {
		expect(phoneSession(deps, "nope")).toBeUndefined();
	});
});
