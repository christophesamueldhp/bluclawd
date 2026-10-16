import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { PaneReport } from "../daemon/ipc/protocol.ts";
import {
	ansiSpans,
	color256,
	pistatusline,
	type RenderRequest,
	StatuslineRenderer,
	type StatuslineWorker,
	statusJson,
	transcriptRecords,
} from "../daemon/remote/pistatusline.ts";
import { loadBranch } from "../daemon/remote/transcript.ts";
import { pistatuslinePaths } from "../ext/remote/report.ts";

const dir = mkdtempSync(join(tmpdir(), "bluclawd-pistatusline-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A worker speaking pistatusline's protocol: one line naming the model, bold, in colour 231, and the width. */
const ECHO_WORKER = `import { parentPort } from "node:worker_threads";
parentPort.on("message", (r) => parentPort.postMessage({
	id: r.id,
	lines: ["\\u001b[0m\\u001b[1m\\u001b[38;5;231m" + r.status.model.display_name + "\\u001b[39m\\u001b[22m " + r.width + " " + JSON.stringify(r.usage)],
	needsUsage: false,
}));
`;

const report: PaneReport = {
	model: { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
	models: [],
	thinkingLevel: "high",
	context: { tokens: 50_000, contextWindow: 200_000, percent: 25 },
	usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 1.23 },
};

describe("pistatusline's lines as styled spans", () => {
	it("turns a rendered line into spans, as the phone draws them: colours, bold, a gradient's per-letter colours", () => {
		// As pistatusline renders "Claude Opus 4.5", a "high" in gradient:atlas and a context bar at colorLevel 2.
		const line =
			"\u001b[0m\u001b[0m \u001b[0m\u001b[1m\u001b[38;5;231mClaude Opus 4.5\u001b[39m\u001b[22m\u001b[0m \u001b[0m" +
			"\u001b[1m\u001b[38;5;216mh\u001b[38;5;181mi\u001b[39m\u001b[22m\u001b[0m \u001b[1m\u001b[38;5;231m▓▓░ 50k\u001b[39m\u001b[22m\u001b[0m";
		expect(ansiSpans(line)).toEqual([
			{ text: " " },
			{ text: "Claude Opus 4.5", fg: "#ffffff", bold: true },
			{ text: " " },
			{ text: "h", fg: "#ffaf87", bold: true },
			{ text: "i", fg: "#d7afaf", bold: true },
			{ text: " " },
			{ text: "▓▓░ 50k", fg: "#ffffff", bold: true },
		]);
	});

	it("reads 16-colour, truecolour and background codes, dim and italic, and drops hyperlinks and other escapes", () => {
		const line =
			"\u001b[97mwhite\u001b[39m \u001b[2;33mdim\u001b[22m\u001b[39m \u001b[38;2;1;2;3;48;5;17mrgb\u001b[0m " +
			"\u001b]8;;https://github.com/x\u0007link\u001b]8;;\u0007 \u001b[3mit\u001b[23m\u001b[K\u0007";
		expect(ansiSpans(line)).toEqual([
			{ text: "white", fg: "#ffffff" },
			{ text: " " },
			{ text: "dim", fg: "#cdcd00", dim: true },
			{ text: " " },
			{ text: "rgb", fg: "#010203", bg: "#00005f" },
			{ text: " link " },
			{ text: "it", italic: true },
		]);
	});

	it("maps the 256 colours as xterm does", () => {
		expect([
			color256(1),
			color256(15),
			color256(16),
			color256(231),
			color256(59),
			color256(232),
			color256(255),
		]).toEqual(["#cd0000", "#ffffff", "#000000", "#ffffff", "#5f5f5f", "#080808", "#eeeeee"]);
	});
});

describe("what the renderer is given", () => {
	it("builds pistatusline's status JSON from the pane's report", () => {
		const session = { id: "pi-1", cwd: "/p", createdAt: "2026-10-15T10:00:00.000Z", sessionId: "s-1" };
		expect(statusJson(session, report, Date.parse("2026-10-15T10:10:00.000Z"))).toEqual({
			session_id: "s-1",
			cwd: "/p",
			workspace: { current_dir: "/p", project_dir: "/p" },
			cost: { total_cost_usd: 1.23, total_duration_ms: 600_000 },
			model: { id: "claude-opus-4-5", display_name: "Claude Opus 4.5" },
			effort: { level: "high" },
			context_window: { context_window_size: 200_000, current_usage: 50_000, used_percentage: 25 },
		});
		const bare = statusJson(
			{ id: "pi-1", cwd: "/p" },
			{ models: [], context: { tokens: null, contextWindow: 1000, percent: null } },
			0,
		);
		expect(bare).toEqual({
			cwd: "/p",
			workspace: { current_dir: "/p", project_dir: "/p" },
			cost: { total_cost_usd: 0 },
			context_window: { context_window_size: 1000 },
		});
	});

	it("derives pistatusline's transcript records from the session's active branch", () => {
		const file = join(dir, "records.jsonl");
		const usage = { input: 10, output: 5, cacheRead: 100, cacheWrite: 1 };
		const entries = [
			{ type: "session", id: "s", cwd: "/p" },
			{ type: "message", id: "u1", parentId: null, timestamp: "t1", message: { role: "user", content: "hi" } },
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: "t2",
				message: { role: "assistant", usage, stopReason: "stop" },
			},
			{
				type: "message",
				id: "a2",
				parentId: "a1",
				timestamp: "t3",
				message: { role: "assistant", usage, stopReason: "aborted" },
			},
			{ type: "compaction", id: "k1", parentId: "a2", timestamp: "t4", tokensBefore: 9000, usage },
			{ type: "model_change", id: "m1", parentId: "k1", timestamp: "t5" },
			// Another branch: left out.
			{ type: "message", id: "u2", parentId: "u1", timestamp: "t6", message: { role: "user", content: "other" } },
		];
		writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n"));
		const tokens = {
			input_tokens: 10,
			output_tokens: 5,
			cache_read_input_tokens: 100,
			cache_creation_input_tokens: 1,
		};
		expect(transcriptRecords(loadBranch(file, "m1"))).toEqual([
			{ type: "user", timestamp: "t1" },
			{
				type: "assistant",
				timestamp: "t2",
				isApiErrorMessage: false,
				message: { usage: tokens, stop_reason: "stop" },
			},
			{
				type: "assistant",
				timestamp: "t3",
				isApiErrorMessage: true,
				message: { usage: tokens, stop_reason: "aborted" },
			},
			{ type: "system", subtype: "compact_boundary", timestamp: "t4", compactMetadata: { preTokens: 9000 } },
			{ type: "assistant", timestamp: "t4", isSidechain: true, message: { usage: tokens, stop_reason: "stop" } },
		]);
	});
});

describe("StatuslineRenderer", () => {
	const request = (width: number): RenderRequest => ({
		configPath: join(dir, "settings.json"),
		width,
		status: { model: { id: "m", display_name: "Opus" } },
		records: [],
		sessionName: null,
		usage: { sessionUsage: 42 },
	});

	it("renders with pistatusline's own worker, one for every request, until it is closed", async () => {
		const worker = join(dir, "render-worker.js");
		writeFileSync(worker, ECHO_WORKER);
		const renderer = new StatuslineRenderer();
		try {
			expect(await renderer.render(worker, request(52))).toEqual([
				'\u001b[0m\u001b[1m\u001b[38;5;231mOpus\u001b[39m\u001b[22m 52 {"sessionUsage":42}',
			]);
			const [a, b] = await Promise.all([renderer.render(worker, request(40)), renderer.render(worker, request(60))]);
			expect([a?.[0]?.includes(" 40 "), b?.[0]?.includes(" 60 ")]).toEqual([true, true]);
		} finally {
			renderer.close();
		}
	});

	it("renders nothing for a worker that fails, never answers, or is not there, and starts another after", async () => {
		vi.useFakeTimers();
		try {
			const silent: StatuslineWorker & { posted: unknown[] } = {
				posted: [],
				postMessage(message) {
					this.posted.push(message);
				},
				on: () => undefined,
				terminate: vi.fn(),
				unref: () => {},
			};
			const spawn = vi.fn((path: string): StatuslineWorker => {
				if (path === "/missing") throw new Error("no such file");
				return silent;
			});
			const renderer = new StatuslineRenderer(spawn);
			const pending = renderer.render("/w.js", request(52));
			await vi.advanceTimersByTimeAsync(3000);
			expect(await pending).toBeUndefined();
			expect(await renderer.render("/missing", request(52))).toBeUndefined();
			// The failed spawn dropped the worker: the next request starts another.
			const again = renderer.render("/w.js", request(52));
			expect(spawn).toHaveBeenCalledTimes(3);
			// A minute without a request ends it.
			await vi.advanceTimersByTimeAsync(60_000);
			expect(await again).toBeUndefined();
			expect(silent.terminate).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}

		const broken = join(dir, "broken-worker.js");
		writeFileSync(broken, "throw new Error('broken');");
		const renderer = new StatuslineRenderer();
		expect(await renderer.render(broken, request(52))).toBeUndefined();
		renderer.close();
	});
});

describe("pistatusline for the phone", () => {
	const session = { id: "pi-1", cwd: "/p" };
	const fakeRenderer = () => {
		const requests: Array<{ path: string; request: RenderRequest }> = [];
		const renderer = {
			render: async (path: string, request: RenderRequest) => {
				requests.push({ path, request });
				return ["\u001b[1mline\u001b[22m"];
			},
		} as unknown as StatuslineRenderer;
		return { renderer, requests };
	};

	it("gives the renderer the plan usage pistatusline keeps for the model's provider, only its usage fields", async () => {
		const agent = join(dir, "plan-agent");
		mkdirSync(join(agent, "pistatusline", "usage"), { recursive: true });
		writeFileSync(
			join(agent, "pistatusline", "usage", "opencode-go.json"),
			JSON.stringify({
				fetchedAt: "2026-10-16T10:00:00.000Z",
				sessionUsage: 63,
				sessionResetAt: "2026-10-16T12:00:00.000Z",
				weeklyUsage: 21,
				weeklyResetAt: "not a time",
				apiKey: "secret",
			}),
		);
		writeFileSync(
			join(agent, "pistatusline", "usage", "anthropic.json"),
			JSON.stringify({
				fetchedAt: "2026-10-16T10:00:00.000Z",
				sessionUsage: 8,
				weeklyOpusUsage: 3,
				extraUsageEnabled: true,
				extraUsageCurrency: "USD",
			}),
		);
		// The ccstatusline cache, which the Anthropic file outranks.
		const usagePath = join(dir, "plan-ccstatusline.json");
		writeFileSync(usagePath, JSON.stringify({ sessionUsage: 99 }));
		const { renderer, requests } = fakeRenderer();
		const render = pistatusline(renderer, usagePath);
		const paths = { worker: "/w/render-worker.js", config: join(agent, "pistatusline", "settings.json") };
		const withModel = (provider: string, id: string) => ({ ...report, model: { provider, id }, pistatusline: paths });
		await render(session, withModel("opencode-go", "glm-5"), 52);
		await render(session, withModel("anthropic", "claude-opus-4-5"), 52);
		await render(session, withModel("kimi-coding", "k2"), 52);
		await render(session, withModel("../../plan-ccstatusline", "x"), 52);
		expect(requests.map((r) => r.request.usage)).toEqual([
			{ sessionUsage: 63, sessionResetAt: "2026-10-16T12:00:00.000Z", weeklyUsage: 21 },
			{ sessionUsage: 8, weeklyOpusUsage: 3, extraUsageEnabled: true, extraUsageCurrency: "USD" },
			null,
			null,
		]);
	});

	it("falls back, for Anthropic only, to the ccstatusline cache's four fields", async () => {
		const usagePath = join(dir, "usage.json");
		writeFileSync(
			usagePath,
			JSON.stringify({
				sessionUsage: 42,
				weeklyUsage: 17,
				tokenHash: "secret",
				sessionResetAt: "2026-10-15T12:00:00Z",
			}),
		);
		const { renderer, requests } = fakeRenderer();
		const render = pistatusline(renderer, usagePath);
		const paths = {
			worker: "/pi/pistatusline/dist/render-worker.js",
			config: join(dir, "no-agent", "pistatusline", "settings.json"),
		};
		expect(await render(session, report, 52)).toBeUndefined();
		expect(await render(session, { ...report, pistatusline: paths }, 52)).toEqual([[{ text: "line", bold: true }]]);
		expect(requests[0]).toMatchObject({ path: paths.worker, request: { configPath: paths.config, width: 52 } });
		expect(requests[0]!.request.usage).toEqual({
			sessionUsage: 42,
			weeklyUsage: 17,
			sessionResetAt: "2026-10-15T12:00:00Z",
		});
		const openai = { ...report, model: { provider: "openai", id: "gpt-5" }, pistatusline: paths };
		await render(session, openai, 52);
		expect(requests[1]!.request.usage).toBeNull();
	});

	it("shares a render among the status fetches of the same report and width that come close together", async () => {
		let now = 0;
		const { renderer, requests } = fakeRenderer();
		const render = pistatusline(renderer, join(dir, "none.json"), () => now);
		const withPaths = { ...report, pistatusline: { worker: "/w/render-worker.js", config: join(dir, "c.json") } };
		await render(session, withPaths, 52);
		await render(session, withPaths, 52);
		expect(requests).toHaveLength(1);
		await render(session, withPaths, 48);
		await render(session, { ...withPaths, thinkingLevel: "low" }, 52);
		expect(requests).toHaveLength(3);
		now = 2000;
		await render(session, withPaths, 52);
		expect(requests).toHaveLength(4);
	});
});

describe("pistatuslinePaths", () => {
	it("finds pistatusline's worker beside its extension, and its settings, unless it is turned off", () => {
		const dist = join(dir, "node_modules", "pistatusline", "dist");
		mkdirSync(dist, { recursive: true });
		writeFileSync(join(dist, "render-worker.js"), "");
		const agentDir = join(dir, "agent");
		const pi = (path: string) => ({
			getCommands: () => [
				{ name: "tasks", source: "extension", sourceInfo: { path: "/elsewhere/index.ts" } },
				{ name: "pistatusline", source: "extension", sourceInfo: { path } },
			],
		});
		expect(pistatuslinePaths(pi(join(dist, "extension.js")) as never, agentDir)).toEqual({
			worker: join(dist, "render-worker.js"),
			config: join(agentDir, "pistatusline", "settings.json"),
		});
		expect(pistatuslinePaths(pi(join(dir, "nowhere", "extension.js")) as never, agentDir)).toBeUndefined();
		expect(pistatuslinePaths({ getCommands: () => [] } as never, agentDir)).toBeUndefined();
		mkdirSync(join(agentDir, "pistatusline"), { recursive: true });
		writeFileSync(join(agentDir, "pistatusline", "state.json"), JSON.stringify({ enabled: false }));
		expect(pistatuslinePaths(pi(join(dist, "extension.js")) as never, agentDir)).toBeUndefined();
	});
});
