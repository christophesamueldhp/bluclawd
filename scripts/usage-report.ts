import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MONITOR_MESSAGE_TYPE, TASK_EXIT_MESSAGE_TYPE } from "../ext/background-bash/monitor-events.ts";
import { WAKEUP_MESSAGE_TYPE } from "../ext/background-bash/wakeups.ts";
import { SUBAGENT_NOTIFICATION_CUSTOM_TYPE } from "../ext/subagents/index.ts";
import { SUBAGENT_MESSAGE_CUSTOM_TYPE } from "../ext/subagents/messages.ts";
import { SUBAGENT_RUN_CUSTOM_ENTRY } from "../ext/subagents/storage.ts";

type Counts = Record<string, number>;

interface Sizes {
	count: number;
	chars: number;
}

const NOTICE_KINDS: Record<string, string> = {
	[TASK_EXIT_MESSAGE_TYPE]: "task exits",
	[MONITOR_MESSAGE_TYPE]: "monitor events",
	[WAKEUP_MESSAGE_TYPE]: "wake-ups",
	[SUBAGENT_NOTIFICATION_CUSTOM_TYPE]: "Reports",
	[SUBAGENT_MESSAGE_CUSTOM_TYPE]: "run messages",
};

export interface Usage {
	tools: Counts;
	declared: Counts;
	subagent: { calls: number; roles: Counts };
	notices: Record<string, Sizes>;
	cache: { awaited: CacheFigures; other: CacheFigures };
}

export interface CacheFigures {
	requests: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface SessionUsage extends Usage {
	name: string;
}

export interface UsageReport {
	sessions: SessionUsage[];
	unparsed: string[];
	total: Usage;
	besideAwaited: CacheFigures;
}

interface Entry {
	type: string;
	customType?: string;
	content?: unknown;
	data?: { runId?: string; admittedAt?: number; endedAt?: number };
	details?: { runs?: unknown[] };
	message?: {
		role: string;
		content?: unknown;
		nestedCalls?: { calls?: unknown[] };
		toolsAdded?: unknown[];
		usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
		timestamp?: number;
	};
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

interface SubagentStep {
	agent?: unknown;
	resume?: unknown;
}

interface SubagentArguments extends SubagentStep {
	tasks?: SubagentStep[];
	chain?: SubagentStep[];
}

const emptyCache = (): CacheFigures => ({ requests: 0, input: 0, cacheRead: 0, cacheWrite: 0 });

const emptyUsage = (): Usage => ({
	tools: {},
	declared: {},
	subagent: { calls: 0, roles: {} },
	notices: {},
	cache: { awaited: emptyCache(), other: emptyCache() },
});

const addCache = (into: CacheFigures, more: CacheFigures) => {
	into.requests += more.requests;
	into.input += more.input;
	into.cacheRead += more.cacheRead;
	into.cacheWrite += more.cacheWrite;
};

const add = (counts: Counts, name: string, by = 1) => {
	counts[name] = (counts[name] ?? 0) + by;
};

const addAll = (counts: Counts, more: Counts) => {
	for (const [name, n] of Object.entries(more)) add(counts, name, n);
};

const addSizes = (sizes: Record<string, Sizes>, kind: string, more: Sizes) => {
	const into = sizes[kind] ?? { count: 0, chars: 0 };
	into.count += more.count;
	into.chars += more.chars;
	sizes[kind] = into;
};

function textChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	return content.reduce((sum, block) => sum + (typeof block?.text === "string" ? block.text.length : 0), 0);
}

const isPrintableName = (value: unknown): value is string => typeof value === "string" && /^[\w.:-]{1,64}$/.test(value);

function roleName(agent: unknown): string {
	if (isPrintableName(agent)) return agent;
	if (isObject(agent) && isPrintableName(agent.name)) return `(inline) ${agent.name}`;
	return "(other)";
}

function subagentRoles(args: SubagentArguments | undefined): string[] {
	const steps = args?.tasks ?? args?.chain ?? [args ?? {}];
	return steps.flatMap((step) =>
		step.resume !== undefined ? ["(resume)"] : step.agent !== undefined ? [roleName(step.agent)] : [],
	);
}

function sessionFiles(dir: string): string[] {
	return readdirSync(dir, { recursive: true, encoding: "utf8" })
		.filter((path) => path.endsWith(".jsonl"))
		.sort();
}

function firstGenerationWindows(entries: Entry[]): { from: number; to: number }[] {
	const runs = new Map<string, { from: number; to: number }>();
	for (const { type, customType, data } of entries) {
		if (type !== "custom" || customType !== SUBAGENT_RUN_CUSTOM_ENTRY || !data?.runId) continue;
		if (typeof data.admittedAt !== "number") continue;
		const run = runs.get(data.runId) ?? { from: data.admittedAt, to: Number.POSITIVE_INFINITY };
		if (run.to === Number.POSITIVE_INFINITY && typeof data.endedAt === "number") run.to = data.endedAt;
		runs.set(data.runId, run);
	}
	return [...runs.values()];
}

function usageOf(entries: Entry[]): Usage {
	const usage = emptyUsage();
	const runs = firstGenerationWindows(entries);
	const awaited = (at: number) => runs.some(({ from, to }) => at >= from && at < to);
	for (const entry of entries) {
		if (entry.type === "custom_message" && entry.customType) {
			const kind =
				NOTICE_KINDS[entry.customType] ?? (isPrintableName(entry.customType) ? entry.customType : "(other)");
			const batchedReports =
				entry.customType === SUBAGENT_NOTIFICATION_CUSTOM_TYPE ? entry.details?.runs : undefined;
			addSizes(usage.notices, kind, {
				count: Array.isArray(batchedReports) ? batchedReports.length : 1,
				chars: textChars(entry.content),
			});
		}
		const message = entry.message;
		if (entry.type !== "message" || !message) continue;
		if (message.role === "system") {
			for (const tool of message.toolsAdded ?? [])
				if (isObject(tool) && isPrintableName(tool.name)) usage.declared[tool.name] = 1;
		}
		if (message.role === "assistant" && message.usage) {
			const requestStartedAt = message.timestamp;
			const whileAwaited = typeof requestStartedAt === "number" && awaited(requestStartedAt);
			addCache(usage.cache[whileAwaited ? "awaited" : "other"], {
				requests: 1,
				input: message.usage.input ?? 0,
				cacheRead: message.usage.cacheRead ?? 0,
				cacheWrite: message.usage.cacheWrite ?? 0,
			});
		}
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (!isObject(block) || block.type !== "toolCall" || typeof block.name !== "string") continue;
				add(usage.tools, isPrintableName(block.name) ? block.name : "(other)");
				if (block.name !== "subagent") continue;
				usage.subagent.calls++;
				for (const role of subagentRoles(block.arguments as SubagentArguments | undefined))
					add(usage.subagent.roles, role);
			}
		}
		if (message.role === "toolResult")
			for (const call of message.nestedCalls?.calls ?? [])
				if (isObject(call)) add(usage.tools, isPrintableName(call.name) ? call.name : "(other)");
	}
	return usage;
}

function merge(total: Usage, usage: Usage): void {
	addAll(total.tools, usage.tools);
	addAll(total.declared, usage.declared);
	total.subagent.calls += usage.subagent.calls;
	addAll(total.subagent.roles, usage.subagent.roles);
	for (const [kind, sizes] of Object.entries(usage.notices)) addSizes(total.notices, kind, sizes);
	addCache(total.cache.awaited, usage.cache.awaited);
	addCache(total.cache.other, usage.cache.other);
}

function readEntries(path: string): Entry[] | undefined {
	try {
		const entries = readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line) as Entry);
		const objects = entries.every((entry) => typeof entry === "object" && entry !== null);
		return objects && entries[0]?.type === "session" ? entries : undefined;
	} catch {
		return undefined;
	}
}

export function usageReport(dir: string): UsageReport {
	const sessions: SessionUsage[] = [];
	const unparsed: string[] = [];
	const total = emptyUsage();
	const besideAwaited = emptyCache();
	for (const path of sessionFiles(dir)) {
		const entries = readEntries(join(dir, path));
		if (!entries) {
			unparsed.push(path);
			continue;
		}
		const usage = usageOf(entries);
		sessions.push({ name: path, ...usage });
		merge(total, usage);
		if (usage.cache.awaited.requests > 0) addCache(besideAwaited, usage.cache.other);
	}
	return { sessions, unparsed, total, besideAwaited };
}

function table(header: string[], rows: (string | number)[][]): string[] {
	const cells = [header, ...rows.map((row) => row.map(String))];
	const widths = header.map((_, i) => Math.max(...cells.map((row) => row[i]?.length ?? 0)));
	return cells.map(
		(row) => `  ${row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join("  ")}`,
	);
}

const byCount = (counts: Counts) => Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

function readShare({ input, cacheRead, cacheWrite }: CacheFigures): string {
	const prompt = input + cacheRead + cacheWrite;
	return prompt === 0 ? "-" : `${Math.round((cacheRead / prompt) * 100)}%`;
}

function formatUsage(usage: Usage, besideAwaited?: CacheFigures): string[] {
	const tools = [...new Set([...Object.keys(usage.tools), ...Object.keys(usage.declared)])]
		.map((name) => [name, usage.tools[name] ?? 0, usage.declared[name] ?? 0] as const)
		.sort((a, b) => b[1] - a[1] || b[2] - a[2] || a[0].localeCompare(b[0]));
	const lines = table(
		["Tool", "Calls", "Declared"],
		tools.map((row) => [...row]),
	);
	lines.push(`  subagent calls: ${usage.subagent.calls}`);
	if (usage.subagent.calls > 0) lines.push(...table(["Role", "Steps"], byCount(usage.subagent.roles)));
	const notices = Object.entries(usage.notices).sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
	lines.push(
		...table(
			["Notice", "Count", "Chars"],
			notices.map(([kind, { count, chars }]) => [kind, count, chars]),
		),
	);
	const { awaited, other } = usage.cache;
	const row = (name: string, figures: CacheFigures) => [
		name,
		figures.requests,
		figures.input,
		figures.cacheRead,
		figures.cacheWrite,
		readShare(figures),
	];
	lines.push(
		...table(
			["Requests", "Count", "Input", "Cache read", "Cache write", "Read share"],
			[
				row("while Runs awaited", awaited),
				...(besideAwaited ? [row("other, same sessions", besideAwaited)] : []),
				row("other", other),
			],
		),
	);
	return lines;
}

export function formatReport(report: UsageReport): string {
	const lines: string[] = [];
	if (report.unparsed.length > 0) {
		lines.push(
			`Unparsed session files (${report.unparsed.length}):`,
			...report.unparsed.map((name) => `  ${name}`),
			"",
		);
	}
	for (const session of report.sessions) lines.push(`Session ${session.name}`, ...formatUsage(session), "");
	lines.push(`Total of ${report.sessions.length} sessions`, ...formatUsage(report.total, report.besideAwaited));
	return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	console.log(formatReport(usageReport(process.argv[2] ?? join(agentDir, "sessions"))));
}
