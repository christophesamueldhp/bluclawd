import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import type { PaneReport } from "../ipc/protocol.ts";
import { readPlanUsage } from "./statusline.ts";
import { type Entry, type EntryUsage, loadBranch } from "./transcript.ts";

export interface StatusSpan {
	text: string;
	fg?: string;
	bg?: string;
	bold?: true;
	dim?: true;
	italic?: true;
	underline?: true;
}

export interface RenderRequest {
	configPath: string;
	width: number;
	status: object;
	records: object[];
	sessionName: string | null;
	usage: object | null;
}

export interface StatuslineSession {
	id: string;
	cwd: string;
	sessionFile?: string;
	leafId?: string;
	createdAt?: string;
	sessionId?: string;
}

export interface StatuslineWorker {
	postMessage(message: unknown): void;
	on(event: "message" | "error" | "exit", listener: (value: unknown) => void): unknown;
	terminate(): unknown;
	unref(): void;
}

const RENDER_TIMEOUT_MS = 3000;
const IDLE_MS = 60_000;
const CACHE_MS = 2000;

const FILE_SAFE_PROVIDER = /^[a-z0-9][a-z0-9._-]*$/i;

function planUsage(report: PaneReport, configPath: string): object | null {
	const provider = report.model?.provider;
	if (!provider || !FILE_SAFE_PROVIDER.test(provider)) return null;
	return readPlanUsage(join(dirname(configPath), "usage", `${provider}.json`)) ?? null;
}

const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export function statusJson(session: StatuslineSession, report: PaneReport, now: number): object {
	const started = session.createdAt ? Date.parse(session.createdAt) : Number.NaN;
	const { context } = report;
	return {
		...(session.sessionId ? { session_id: session.sessionId } : {}),
		cwd: session.cwd,
		workspace: { current_dir: session.cwd, project_dir: session.cwd },
		cost: {
			total_cost_usd: finite(report.usage?.cost),
			...(Number.isFinite(started) ? { total_duration_ms: Math.max(0, now - started) } : {}),
		},
		...(report.model ? { model: { id: report.model.id, display_name: report.model.name ?? report.model.id } } : {}),
		// pi's thinking level is "off" for a model that does not reason, which the report leaves out.
		...(report.model ? { effort: { level: report.thinkingLevel ?? "off" } } : {}),
		...(context
			? {
					context_window: {
						context_window_size: context.contextWindow,
						...(context.tokens === null ? {} : { current_usage: context.tokens }),
						...(context.percent === null ? {} : { used_percentage: context.percent }),
					},
				}
			: {}),
	};
}

function tokenUsage(usage: EntryUsage) {
	return {
		input_tokens: finite(usage.input),
		output_tokens: finite(usage.output),
		cache_read_input_tokens: finite(usage.cacheRead),
		cache_creation_input_tokens: finite(usage.cacheWrite),
	};
}

export function transcriptRecords(entries: Entry[]): object[] {
	const records: object[] = [];
	for (const entry of entries) {
		const { timestamp } = entry;
		if (entry.type === "message") {
			const message = entry.message;
			if (message?.role === "user") records.push({ type: "user", timestamp });
			else if (message?.role === "assistant" && message.usage) {
				const total = Object.values(tokenUsage(message.usage)).reduce((sum, n) => sum + n, 0);
				const counts = message.stopReason !== "error" && message.stopReason !== "aborted" && total > 0;
				records.push({
					type: "assistant",
					timestamp,
					isApiErrorMessage: !counts,
					message: { usage: tokenUsage(message.usage), stop_reason: message.stopReason ?? "stop" },
				});
			}
			continue;
		}
		if (entry.type === "compaction") {
			records.push({
				type: "system",
				subtype: "compact_boundary",
				timestamp,
				compactMetadata: { preTokens: entry.tokensBefore },
			});
		}
		if (entry.usage && (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "usage")) {
			records.push({
				type: "assistant",
				timestamp,
				isSidechain: true,
				message: { usage: tokenUsage(entry.usage), stop_reason: "stop" },
			});
		}
	}
	return records;
}

const XTERM_COLOURS = [
	"#000000",
	"#cd0000",
	"#00cd00",
	"#cdcd00",
	"#0000ee",
	"#cd00cd",
	"#00cdcd",
	"#e5e5e5",
	"#7f7f7f",
	"#ff0000",
	"#00ff00",
	"#ffff00",
	"#5c5cff",
	"#ff00ff",
	"#00ffff",
	"#ffffff",
];
const CUBE = [0, 95, 135, 175, 215, 255];
const hex = (...rgb: number[]) => `#${rgb.map((n) => n.toString(16).padStart(2, "0")).join("")}`;

export function color256(n: number): string {
	if (n < 16) return XTERM_COLOURS[n]!;
	if (n < 232) return hex(CUBE[Math.floor((n - 16) / 36)]!, CUBE[Math.floor((n - 16) / 6) % 6]!, CUBE[(n - 16) % 6]!);
	const gray = 8 + (n - 232) * 10;
	return hex(gray, gray, gray);
}

type Style = Omit<StatusSpan, "text">;

function sgrColor(params: number[], i: number): { color: string | undefined; consumed: number } {
	const code = params[i]!;
	if (code === 38 || code === 48) {
		if (params[i + 1] === 5) return { color: color256(params[i + 2] ?? 0), consumed: 3 };
		if (params[i + 1] === 2)
			return { color: hex(params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0), consumed: 5 };
		return { color: undefined, consumed: 1 };
	}
	// 30–37 and 40–47 are the normal colours, 90–97 and 100–107 the bright ones.
	return {
		color: XTERM_COLOURS[code >= 100 ? code - 92 : code >= 90 ? code - 82 : code >= 40 ? code - 40 : code - 30],
		consumed: 1,
	};
}

const STYLE_KEYS = ["fg", "bg", "bold", "dim", "italic", "underline"] as const;
const sameStyle = (a: Style, b: Style) => STYLE_KEYS.every((key) => a[key] === b[key]);

function applySgr(style: Style, params: number[]): Style {
	let next: Style = { ...style };
	for (let i = 0; i < params.length; ) {
		const code = params[i]!;
		let used = 1;
		if (code === 0) next = {};
		else if (code === 1) next.bold = true;
		else if (code === 2) next.dim = true;
		else if (code === 22) {
			delete next.bold;
			delete next.dim;
		} else if (code === 3) next.italic = true;
		else if (code === 23) delete next.italic;
		else if (code === 4) next.underline = true;
		else if (code === 24) delete next.underline;
		else if (code === 39) delete next.fg;
		else if (code === 49) delete next.bg;
		else if ((code >= 30 && code <= 38) || (code >= 90 && code <= 97)) {
			const { color, consumed } = sgrColor(params, i);
			used = consumed;
			if (color) next.fg = color;
		} else if ((code >= 40 && code <= 48) || (code >= 100 && code <= 107)) {
			const { color, consumed } = sgrColor(params, i);
			used = consumed;
			if (color) next.bg = color;
		}
		i += used;
	}
	return next;
}

/** OSC (a hyperlink), SGR, and any other CSI escape. */
const ESCAPE = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)|\u001b\[([\d;:]*)([A-Za-z])|\u001b[@-_]/g;

export function ansiSpans(line: string): StatusSpan[] {
	const spans: StatusSpan[] = [];
	let style: Style = {};
	const push = (raw: string) => {
		const text = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
		if (!text) return;
		const last = spans.at(-1);
		if (last && sameStyle(last, style)) last.text += text;
		else spans.push({ text, ...style });
	};
	let at = 0;
	for (const match of line.matchAll(ESCAPE)) {
		push(line.slice(at, match.index));
		at = match.index + match[0].length;
		if (match[2] === "m") {
			const params = (match[1] || "0").split(/[;:]/).map((p) => (p === "" ? 0 : Number(p)));
			style = applySgr(style, params);
		}
	}
	push(line.slice(at));
	return spans;
}

export class StatuslineRenderer {
	private worker: { path: string; handle: StatuslineWorker } | undefined;
	private readonly pending = new Map<number, (lines: string[] | undefined) => void>();
	private nextId = 1;
	private idle: ReturnType<typeof setTimeout> | undefined;
	private readonly spawn: (path: string) => StatuslineWorker;

	constructor(spawn: (path: string) => StatuslineWorker = (path) => new Worker(path)) {
		this.spawn = spawn;
	}

	render(workerPath: string, request: RenderRequest): Promise<string[] | undefined> {
		const worker = this.ensure(workerPath);
		if (!worker) return Promise.resolve(undefined);
		clearTimeout(this.idle);
		this.idle = setTimeout(() => this.close(), IDLE_MS);
		this.idle.unref();
		const id = this.nextId++;
		return new Promise((resolve) => {
			const timer = setTimeout(() => this.settle(id, undefined), RENDER_TIMEOUT_MS);
			timer.unref();
			this.pending.set(id, (lines) => {
				clearTimeout(timer);
				resolve(lines);
			});
			worker.postMessage({ ...request, id });
		});
	}

	private settle(id: number, lines: string[] | undefined): void {
		const done = this.pending.get(id);
		this.pending.delete(id);
		done?.(lines);
	}

	private ensure(path: string): StatuslineWorker | undefined {
		if (this.worker?.path === path) return this.worker.handle;
		this.close();
		let handle: StatuslineWorker;
		try {
			handle = this.spawn(path);
		} catch {
			return undefined;
		}
		handle.unref();
		handle.on("message", (value) => {
			const { id, lines, error } = (value ?? {}) as { id?: unknown; lines?: unknown; error?: unknown };
			if (typeof id !== "number") return;
			const ok = !error && Array.isArray(lines) && lines.every((line) => typeof line === "string");
			this.settle(id, ok ? (lines as string[]) : undefined);
		});
		const gone = () => {
			if (this.worker?.handle === handle) this.close();
		};
		handle.on("error", gone);
		handle.on("exit", gone);
		this.worker = { path, handle };
		return handle;
	}

	close(): void {
		clearTimeout(this.idle);
		this.idle = undefined;
		const worker = this.worker;
		this.worker = undefined;
		for (const id of [...this.pending.keys()]) this.settle(id, undefined);
		terminateUnlessGone(worker?.handle);
	}
}

function terminateUnlessGone(worker: StatuslineWorker | undefined): void {
	try {
		worker?.terminate();
	} catch {}
}

export function pistatusline(
	renderer: StatuslineRenderer = new StatuslineRenderer(),
	now: () => number = Date.now,
): (session: StatuslineSession, report: PaneReport, cols: number) => Promise<StatusSpan[][] | undefined> {
	const cache = new Map<string, { at: number; lines: Promise<StatusSpan[][] | undefined> }>();
	return (session, report, cols) => {
		const paths = report.pistatusline;
		if (!paths) return Promise.resolve(undefined);
		const key = JSON.stringify([session.id, cols, session.leafId, report]);
		const hit = cache.get(key);
		if (hit && now() - hit.at < CACHE_MS) return hit.lines;
		for (const [k, entry] of cache) if (now() - entry.at >= CACHE_MS) cache.delete(k);
		const lines = renderer
			.render(paths.worker, {
				configPath: paths.config,
				width: cols,
				status: statusJson(session, report, now()),
				records: transcriptRecords(loadBranch(session.sessionFile, session.leafId)),
				sessionName: null,
				usage: planUsage(report, paths.config),
			})
			.then((rendered) => rendered?.map(ansiSpans));
		cache.set(key, { at: now(), lines });
		return lines;
	};
}
