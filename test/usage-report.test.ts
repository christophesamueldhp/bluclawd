import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatReport, usageReport } from "../scripts/usage-report.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sessionsDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "bluclawd-usage-"));
	dirs.push(dir);
	return dir;
}

let ids = 0;

/** Writes a session file under `dir`: pi's header, then `entries` as they are stored. */
function writeSession(dir: string, path: string, entries: object[]): void {
	const lines = [
		{ type: "session", version: 3, id: `s${ids++}`, timestamp: "2026-11-12T00:00:00.000Z", cwd: "/work" },
		...entries.map((entry) => ({ id: `e${ids++}`, parentId: null, timestamp: "2026-11-12T00:00:00.000Z", ...entry })),
	];
	mkdirSync(dirname(join(dir, path)), { recursive: true });
	writeFileSync(join(dir, path), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

interface Usage {
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

/** An assistant message: one request, calling `calls` as `[name, arguments]`. */
function request(at: number, calls: [string, object][] = [], usage: Usage = {}) {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "assistant text" },
				...calls.map(([name, args], i) => ({ type: "toolCall", id: `c${at}-${i}`, name, arguments: args })),
			],
			usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, ...usage },
			stopReason: calls.length > 0 ? "toolUse" : "stop",
			timestamp: at,
		},
	};
}

describe("usageReport", () => {
	it("counts the tools each session called, and in total", () => {
		const dir = sessionsDir();
		writeSession(dir, "a/one.jsonl", [
			request(1, [
				["bash", { command: "ls" }],
				["read", { path: "x" }],
			]),
			request(2, [["bash", { command: "pwd" }]]),
		]);
		writeSession(dir, "b/two.jsonl", [request(3, [["edit", { path: "y" }]])]);

		const report = usageReport(dir);

		expect(report.sessions.map((session) => [session.name, session.tools])).toEqual([
			["a/one.jsonl", { bash: 2, read: 1 }],
			["b/two.jsonl", { edit: 1 }],
		]);
		expect(report.total.tools).toEqual({ bash: 2, read: 1, edit: 1 });
	});

	it("counts the sessions that declared each tool, called or not", () => {
		const system = (tools: string[]) => ({
			type: "message",
			message: {
				role: "system",
				content: "",
				sections: { preamble: "system prompt" },
				toolsAdded: tools.map((name) => ({ name, description: "described", parameters: {} })),
				timestamp: 0,
			},
		});
		const dir = sessionsDir();
		// Declared again after a reload: still one session.
		writeSession(dir, "one.jsonl", [system(["bash", "monitor"]), system(["monitor"]), request(1, [["bash", {}]])]);
		writeSession(dir, "two.jsonl", [system(["bash"])]);

		const report = usageReport(dir);

		expect(report.sessions[0].declared).toEqual({ bash: 1, monitor: 1 });
		expect(report.total.declared).toEqual({ bash: 2, monitor: 1 });
	});

	it("counts the tools called from within pi's codemode as calls of those tools", () => {
		const dir = sessionsDir();
		writeSession(dir, "one.jsonl", [
			request(1, [["codemode", { code: "secret code" }]]),
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "c1-0",
					toolName: "codemode",
					content: [{ type: "text", text: "result" }],
					isError: false,
					nestedCalls: {
						calls: [
							{ id: "n1", name: "monitor", status: "done", arguments: {} },
							{ id: "n2", name: "bash", status: "done", arguments: {} },
						],
						complete: true,
					},
					timestamp: 1,
				},
			},
		]);

		expect(usageReport(dir).total.tools).toEqual({ codemode: 1, monitor: 1, bash: 1 });
	});

	it("counts subagent calls and the roles they ran, by name only", () => {
		const dir = sessionsDir();
		writeSession(dir, "one.jsonl", [
			request(1, [["subagent", { agent: "explorer", task: "find it" }]]),
			request(2, [
				[
					"subagent",
					{
						tasks: [
							{ agent: "explorer", task: "a" },
							{ agent: "general-purpose", task: "b" },
						],
					},
				],
			]),
			request(3, [
				[
					"subagent",
					{
						chain: [
							{ agent: "general-purpose", task: "c" },
							{ resume: "sub_1", task: "d" },
							{ agent: "reviewer", task: "e" },
						],
					},
				],
			]),
			request(4, [["subagent", { agent: "please review my secret plan", task: "f" }]]),
		]);

		expect(usageReport(dir).total.subagent).toEqual({
			calls: 4,
			roles: { explorer: 2, "general-purpose": 2, reviewer: 1, "(resume)": 1, "(other)": 1 },
		});
	});

	it("counts and sizes the notices injected into the session, by kind", () => {
		const notice = (customType: string, content: string | { type: "text"; text: string }[]) => ({
			type: "custom_message",
			customType,
			content,
			display: true,
		});
		const dir = sessionsDir();
		writeSession(dir, "one.jsonl", [
			notice("bluclawd:task-exit", "12345"),
			notice("bluclawd:task-exit", "123"),
			notice("bluclawd:monitor", "1234567"),
			notice("bluclawd:wakeup", "12"),
			notice("subagent-notification", [
				{ type: "text", text: "1234" },
				{ type: "text", text: "56" },
			]),
			notice("subagent-message", "1"),
			notice("web-search-results", "1234"),
		]);

		expect(usageReport(dir).total.notices).toEqual({
			"task exits": { count: 2, chars: 8 },
			"monitor events": { count: 1, chars: 7 },
			"wake-ups": { count: 1, chars: 2 },
			Reports: { count: 1, chars: 6 },
			"run messages": { count: 1, chars: 1 },
			"web-search-results": { count: 1, chars: 4 },
		});
	});

	it("splits the cache figures between requests made while Runs were awaited and the others", () => {
		const run = (runId: string, status: string, admittedAt: number, endedAt?: number) => ({
			type: "custom",
			customType: "bluclawd.subagent-run",
			data: { runId, agentName: "explorer", status, deliveryMode: "background", admittedAt, endedAt },
		});
		const dir = sessionsDir();
		writeSession(dir, "one.jsonl", [
			request(50, [], { input: 100, cacheRead: 1000, cacheWrite: 10 }),
			run("sub_1", "starting", 100),
			request(150, [], { input: 200, cacheRead: 2000, cacheWrite: 20 }),
			run("sub_1", "completed", 100, 200),
			request(250, [], { input: 300, cacheRead: 3000, cacheWrite: 30 }),
			// Never ended in this file: awaited to the end of it.
			run("sub_2", "starting", 300),
			request(400, [], { input: 400, cacheRead: 4000, cacheWrite: 40 }),
		]);

		expect(usageReport(dir).total.cache).toEqual({
			awaited: { requests: 2, input: 600, cacheRead: 6000, cacheWrite: 60 },
			besideAwaited: { requests: 2, input: 400, cacheRead: 4000, cacheWrite: 40 },
			other: { requests: 2, input: 400, cacheRead: 4000, cacheWrite: 40 },
		});
	});

	it("totals the other requests of the sessions that awaited Runs apart, to compare like with like", () => {
		const dir = sessionsDir();
		writeSession(dir, "runs.jsonl", [
			{
				type: "custom",
				customType: "bluclawd.subagent-run",
				data: { runId: "sub_1", status: "completed", admittedAt: 100, endedAt: 200 },
			},
			request(150, [], { input: 10, cacheRead: 90 }),
			request(250, [], { input: 20, cacheRead: 80 }),
		]);
		writeSession(dir, "no-runs.jsonl", [request(1, [], { input: 50, cacheRead: 50 })]);

		expect(usageReport(dir).total.cache).toEqual({
			awaited: { requests: 1, input: 10, cacheRead: 90, cacheWrite: 0 },
			besideAwaited: { requests: 1, input: 20, cacheRead: 80, cacheWrite: 0 },
			other: { requests: 2, input: 70, cacheRead: 130, cacheWrite: 0 },
		});
	});

	it("names the files it cannot parse and leaves them out of the figures", () => {
		const dir = sessionsDir();
		writeSession(dir, "good.jsonl", [request(1, [["bash", {}]])]);
		writeSession(dir, "torn.jsonl", [request(2, [["read", {}]])]);
		writeFileSync(join(dir, "torn.jsonl"), '{"type":"message","mess', { flag: "a" });
		writeFileSync(join(dir, "headless.jsonl"), `${JSON.stringify(request(3, [["edit", {}]]))}\n`);
		writeFileSync(join(dir, "empty.jsonl"), "");
		writeSession(dir, "null-line.jsonl", []);
		writeFileSync(join(dir, "null-line.jsonl"), "null\n", { flag: "a" });

		const report = usageReport(dir);

		expect(report.sessions.map((session) => session.name)).toEqual(["good.jsonl"]);
		expect(report.unparsed).toEqual(["empty.jsonl", "headless.jsonl", "null-line.jsonl", "torn.jsonl"]);
		expect(report.total.tools).toEqual({ bash: 1 });
	});
});

describe("formatReport", () => {
	it("prints names, counts and sizes, never what the session said", () => {
		const secrets = [
			"USER-SECRET",
			"ASSISTANT-SECRET",
			"ARGUMENT-SECRET",
			"RESULT-SECRET",
			"NOTICE-SECRET",
			"DATA-SECRET",
		];
		const dir = sessionsDir();
		writeSession(dir, "work/one.jsonl", [
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "USER-SECRET" }], timestamp: 1 } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "ASSISTANT-SECRET" },
						{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo ARGUMENT-SECRET" } },
						{
							type: "toolCall",
							id: "c2",
							name: "subagent",
							arguments: { agent: "ARGUMENT-SECRET now", task: "x" },
						},
					],
					usage: { input: 120, output: 5, cacheRead: 880, cacheWrite: 0 },
					stopReason: "toolUse",
					timestamp: 2,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "bash",
					content: [{ type: "text", text: "RESULT-SECRET" }],
					isError: false,
					timestamp: 3,
				},
			},
			{ type: "custom_message", customType: "bluclawd:task-exit", content: "NOTICE-SECRET", display: true },
			{ type: "custom", customType: "web-search-results", data: { query: "DATA-SECRET" } },
		]);
		writeFileSync(join(dir, "torn.jsonl"), "{");

		const text = formatReport(usageReport(dir));

		for (const secret of secrets) expect(text).not.toContain(secret);
		expect(text).toContain("work/one.jsonl");
		expect(text).toContain("torn.jsonl");
		expect(text).toMatch(/bash\s+1/);
		expect(text).toMatch(/task exits\s+1\s+13/);
		// 880 of the 1,000 tokens read from the cache.
		expect(text).toContain("88%");
	});
});
