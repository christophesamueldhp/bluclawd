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
	 * Token figures of the requests made while a Run was awaited, and of the others. A Run counts as awaited from its admission to the end of its first
	 * generation: the session files do not say when it sat idle, so this is an upper bound, and a Resume records no
	 * start, so later generations are left out.
	 */
	cache: { awaited: CacheFigures; other: CacheFigures };
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
	/** The other requests of the sessions that awaited Runs, to set beside the awaited requests. */
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

/** The characters of a message's text, whether stored as a string or as text blocks. */
function textChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	return content.reduce((sum, block) => sum + (typeof block?.text === "string" ? block.text.length : 0), 0);
}

const isName = (value: unknown): value is string => typeof value === "string" && /^[\w.:-]{1,64}$/.test(value);

/** A role as the model named it; anything not shaped like a name is not printed, as it may be the user's text. */
function roleName(agent: unknown): string {
	if (isName(agent)) return agent;
	// A role defined in the call itself.
	if (isObject(agent) && isName(agent.name)) return `(inline) ${agent.name}`;
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

/** When each Run of the session was admitted and when its first generation ended, from its records. */
function runIntervals(entries: Entry[]): { from: number; to: number }[] {
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
	const runs = runIntervals(entries);
	const awaited = (at: number) => runs.some(({ from, to }) => at >= from && at < to);
	for (const entry of entries) {
		if (entry.type === "custom_message" && entry.customType) {
			const kind = NOTICE_KINDS[entry.customType] ?? (isName(entry.customType) ? entry.customType : "(other)");
			// Reports that arrive together are delivered as one message.
			const runs = entry.customType === SUBAGENT_NOTIFICATION_CUSTOM_TYPE ? entry.details?.runs : undefined;
			addSizes(usage.notices, kind, {
				count: Array.isArray(runs) ? runs.length : 1,
				chars: textChars(entry.content),
			});
		}
		const message = entry.message;
		if (entry.type !== "message" || !message) continue;
		if (message.role === "system") {
			for (const tool of message.toolsAdded ?? [])
				if (isObject(tool) && isName(tool.name)) usage.declared[tool.name] = 1;
		}
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
			for (const block of message.content) {
				if (!isObject(block) || block.type !== "toolCall" || typeof block.name !== "string") continue;
				add(usage.tools, isName(block.name) ? block.name : "(other)");
				if (block.name !== "subagent") continue;
				usage.subagent.calls++;
				for (const role of subagentRoles(block.arguments as SubagentArguments | undefined))
					add(usage.subagent.roles, role);
			}
		}
		// The tools pi's codemode called for the model are recorded on its result.
		if (message.role === "toolResult")
			for (const call of message.nestedCalls?.calls ?? [])
				if (isObject(call)) add(usage.tools, isName(call.name) ? call.name : "(other)");
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

/** With `besideAwaited`, the awaited requests are set beside the other requests of the same sessions. */
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
	lines.push(`Total of ${report.sessions.length} sessions`, ...formatUsage(report.total, report.besideAwaited));
	return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	console.log(formatReport(usageReport(process.argv[2] ?? join(agentDir, "sessions"))));
}
