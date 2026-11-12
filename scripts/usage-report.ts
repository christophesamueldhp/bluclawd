// Reports how bluclawd's tools are used in practice, from pi's session files: no model is called and nothing goes
// over the network. Session files hold the user's conversations, so the report prints names, counts and sizes only.
//
//   node scripts/usage-report.ts [sessions directory]
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

/** The kinds of notice bluclawd injects into a session; another's is reported by its custom type. */
const NOTICE_KINDS: Record<string, string> = {
	[TASK_EXIT_MESSAGE_TYPE]: "task exits",
	[MONITOR_MESSAGE_TYPE]: "monitor events",
	[WAKEUP_MESSAGE_TYPE]: "wake-ups",
	[SUBAGENT_NOTIFICATION_CUSTOM_TYPE]: "Reports",
	[SUBAGENT_MESSAGE_CUSTOM_TYPE]: "run messages",
};

export interface Usage {
	/** Tool calls by tool name. */
	tools: Counts;
	/** The sessions that declared each tool to the model, whether it called it or not. */
	declared: Counts;
	/** `subagent` calls, and how many of their steps asked for each role, by name. */
	subagent: { calls: number; roles: Counts };
	/** Notices injected into the session by kind: how many, and their characters. */
	notices: Record<string, Sizes>;
	/**
	 * Token figures of the requests made while a Run was awaited, of the other requests of the sessions that made
	 * such requests, and of all other requests. A Run counts as awaited from its admission to its end: the session
	 * files do not say when it sat idle, so this is an upper bound.
	 */
	cache: { awaited: CacheFigures; besideAwaited: CacheFigures; other: CacheFigures };
}

export interface CacheFigures {
	requests: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface SessionUsage extends Usage {
	/** The session file, relative to the directory read. */
	name: string;
}

export interface UsageReport {
	sessions: SessionUsage[];
	/** Files that are not session files pi could read, relative to the directory read. */
	unparsed: string[];
	total: Usage;
}

interface Entry {
	type: string;
	customType?: string;
	content?: unknown;
	data?: { runId?: string; admittedAt?: number; endedAt?: number };
	message?: {
		role: string;
		content?: unknown;
		nestedCalls?: { calls?: { name: string }[] };
		toolsAdded?: { name: string }[];
		usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
		timestamp?: number;
	};
}

interface ToolCall {
	type: "toolCall";
	name: string;
	arguments?: SubagentArguments;
}

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
	cache: { awaited: emptyCache(), besideAwaited: emptyCache(), other: emptyCache() },
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

/** The characters of a message's text, whether stored as a string or as text blocks. */
function textChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	return content.reduce((sum, block) => sum + (typeof block?.text === "string" ? block.text.length : 0), 0);
}

/** A role as the model named it; anything not shaped like a name is not printed, as it may be the user's text. */
const roleName = (agent: unknown) => (typeof agent === "string" && /^[\w.-]{1,64}$/.test(agent) ? agent : "(other)");

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

/** When each Run of the session was admitted and, once it ended, when; its latest record holds both. */
function runIntervals(entries: Entry[]): { from: number; to: number }[] {
	const runs = new Map<string, { from: number; to: number }>();
	for (const { type, customType, data } of entries) {
		if (type !== "custom" || customType !== SUBAGENT_RUN_CUSTOM_ENTRY || !data?.runId) continue;
		if (typeof data.admittedAt !== "number") continue;
		runs.set(data.runId, { from: data.admittedAt, to: data.endedAt ?? Number.POSITIVE_INFINITY });
	}
	return [...runs.values()];
}

function usageOf(entries: Entry[]): Usage {
	const usage = emptyUsage();
	const runs = runIntervals(entries);
	const awaited = (at: number) => runs.some(({ from, to }) => at >= from && at < to);
	for (const entry of entries) {
		if (entry.type === "custom_message" && entry.customType) {
			const kind = NOTICE_KINDS[entry.customType] ?? entry.customType;
			addSizes(usage.notices, kind, { count: 1, chars: textChars(entry.content) });
		}
		const message = entry.message;
		if (entry.type !== "message" || !message) continue;
		if (message.role === "system") for (const tool of message.toolsAdded ?? []) usage.declared[tool.name] = 1;
		if (message.role === "assistant" && message.usage) {
			// An assistant message is stamped as its request's stream starts.
			const at = message.timestamp;
			addCache(usage.cache[typeof at === "number" && awaited(at) ? "awaited" : "other"], {
				requests: 1,
				input: message.usage.input ?? 0,
				cacheRead: message.usage.cacheRead ?? 0,
				cacheWrite: message.usage.cacheWrite ?? 0,
			});
		}
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content as ToolCall[]) {
				if (block.type !== "toolCall") continue;
				add(usage.tools, block.name);
				if (block.name !== "subagent") continue;
				usage.subagent.calls++;
				for (const role of subagentRoles(block.arguments)) add(usage.subagent.roles, role);
			}
		}
		// The tools pi's codemode called for the model are recorded on its result.
		if (message.role === "toolResult")
			for (const call of message.nestedCalls?.calls ?? []) add(usage.tools, call.name);
	}
	if (usage.cache.awaited.requests > 0) addCache(usage.cache.besideAwaited, usage.cache.other);
	return usage;
}

function merge(total: Usage, usage: Usage): void {
	addAll(total.tools, usage.tools);
	addAll(total.declared, usage.declared);
	total.subagent.calls += usage.subagent.calls;
	addAll(total.subagent.roles, usage.subagent.roles);
	for (const [kind, sizes] of Object.entries(usage.notices)) addSizes(total.notices, kind, sizes);
	addCache(total.cache.awaited, usage.cache.awaited);
	addCache(total.cache.besideAwaited, usage.cache.besideAwaited);
	addCache(total.cache.other, usage.cache.other);
}

/** The file's entries, or undefined when a line is not a JSON object or it does not start with pi's session header. */
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
	for (const path of sessionFiles(dir)) {
		const entries = readEntries(join(dir, path));
		if (!entries) {
			unparsed.push(path);
			continue;
		}
		const usage = usageOf(entries);
		sessions.push({ name: path, ...usage });
		merge(total, usage);
	}
	return { sessions, unparsed, total };
}

/** Rows under a header, the first column left-aligned and the others right-aligned, indented by two spaces. */
function table(header: string[], rows: (string | number)[][]): string[] {
	const cells = [header, ...rows.map((row) => row.map(String))];
	const widths = header.map((_, i) => Math.max(...cells.map((row) => row[i]?.length ?? 0)));
	return cells.map(
		(row) => `  ${row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join("  ")}`,
	);
}

const byCount = (counts: Counts) => Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

/** The share of a request's prompt tokens read from the cache. */
function readShare({ input, cacheRead, cacheWrite }: CacheFigures): string {
	const prompt = input + cacheRead + cacheWrite;
	return prompt === 0 ? "-" : `${Math.round((cacheRead / prompt) * 100)}%`;
}

/** With `total`, the requests made while Runs were awaited are set beside the other requests of the same sessions. */
function formatUsage(usage: Usage, total = false): string[] {
	const tools = [...new Set([...Object.keys(usage.tools), ...Object.keys(usage.declared)])]
		.map((name) => [name, usage.tools[name] ?? 0, usage.declared[name] ?? 0] as const)
		.sort((a, b) => b[1] - a[1] || b[2] - a[2] || a[0].localeCompare(b[0]));
	const lines = table(
		["Tool", "Calls", total ? "Declared in" : "Declared"],
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
	const { awaited, besideAwaited, other } = usage.cache;
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
				...(total ? [row("other, same sessions", besideAwaited)] : []),
				row("other", other),
			],
		),
	);
	return lines;
}

/** The report as text: names, counts and sizes only, never what a session said. */
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
	lines.push(`Total of ${report.sessions.length} sessions`, ...formatUsage(report.total, true));
	return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	console.log(formatReport(usageReport(process.argv[2] ?? join(agentDir, "sessions"))));
}
