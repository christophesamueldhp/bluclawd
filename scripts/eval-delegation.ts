/**
 * Comparative delegation evaluation: the same tasks, model and thinking level, done by stock pi with no extensions,
 * by pi with bluclawd's subagents (RPC runs), and, live only, by pi with pi's own example subagent extension (an
 * example it ships, not built-in behavior). Or done by two bluclawd checkouts, `before` and `after`, each loading the
 * extensions that register tools, to compare two versions of their text. Each trial is graded by the fixture's tests
 * or check and final tree, never by the transcript, and measured: usage of every session, wall time, run startup,
 * parent wakeups, duplicated work, Integration conflicts, peak processes, and the parent's tool calls, failed calls
 * and `bash` calls ended at their timeout.
 *
 * A live comparison spends real model calls; the budget is this experiment's control, never a production limit. Its
 * flags are in `USAGE` below and in docs/research/delegation-efficiency.md.
 *
 * Credentials come from the environment (a provider's API key variable); from `--auth`, the user's auth.json, linked
 * into each trial's fresh agent dir once one call per provider showed pi writes through the link; or from
 * `--agent-dir`, an agent dir used as it is: give it a dedicated one, since every trial's sessions, Run records and
 * worktrees are left there.
 */
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { piPackageRoot } from "../daemon/orchestrator-client.ts";
import { isTerminalSubagentStatus, type SubagentLifecycleStatus } from "../ext/subagents/runs.ts";
import { createFixture, EvaluationBudget, type FixtureGrade, gradeFixture, passPowerK } from "./eval-subagents.ts";
import { ORCHESTRATOR_EXTENSIONS } from "./prompt-footprint.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const PI_CODING_AGENT = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const PI_CLI = join(PI_CODING_AGENT, "bundle/cli.js");
const EXAMPLE = join(PI_CODING_AGENT, "../examples/extensions/subagent");

/** `before` and `after` load bluclawd's tool extensions from a checkout each: two versions of its text, compared. */
export type Arm = "stock" | "bluclawd" | "example" | "before" | "after";
export const ARMS: readonly Arm[] = ["stock", "bluclawd", "example"];

/** The tool extensions of the bluclawd `checkout` a `before` or `after` arm loads. */
function checkoutExtensions(arm: Arm, checkout: string | undefined): string[] {
	if (!checkout) throw new Error(`The ${arm} arm needs the bluclawd checkout it loads`);
	const paths = ORCHESTRATOR_EXTENSIONS.map((path) => join(checkout, path));
	// A fresh worktree has no dependencies until they are installed: said here, rather than by pi failing to start.
	const missing = [...paths, join(checkout, "node_modules")].filter((path) => !existsSync(path));
	if (missing.length > 0) throw new Error(`The ${arm} arm's checkout lacks ${missing.join(", ")}`);
	return paths;
}

/** Whether each arm loads bluclawd, and the extensions it loads; `before` and `after` take theirs from `checkout`. */
const ARM_SETUP: Record<Arm, { bluclawd: boolean; extensions: (checkout?: string) => string[] }> = {
	stock: { bluclawd: false, extensions: () => [] },
	bluclawd: { bluclawd: true, extensions: () => [join(root, "ext/subagents/index.ts")] },
	example: { bluclawd: false, extensions: () => [join(EXAMPLE, "index.ts")] },
	before: { bluclawd: true, extensions: (checkout) => checkoutExtensions("before", checkout) },
	after: { bluclawd: true, extensions: (checkout) => checkoutExtensions("after", checkout) },
};

export interface Scenario {
	name: string;
	files: Record<string, string>;
	/** What the user asks, the same for every arm. */
	prompt: string;
	/** Functions the final tree must define exactly once. */
	functions: string[];
	/** For a question: what the final answer must say. The tree must then stay as it was. */
	answer?: RegExp;
	/** Grades the final tree in place of the fixture's tests: why the outcome is wrong, or nothing when it is right. */
	check?: (cwd: string) => string | undefined;
	/** pi's `--tools` for every arm: turns on a tool the scenario measures that is off by default. */
	tools?: string[];
}

const PACKAGE = JSON.stringify({ name: "fixture", private: true, type: "module" });
const testFile = (module: string, body: string) =>
	`import { test } from "node:test";\nimport assert from "node:assert/strict";\n${module}\n${body}\n`;
const UTIL = "export function clamp(value, min, max) {\n\treturn Math.min(max, Math.max(min, value));\n}\n";
const UTIL_TEST = testFile(
	'import { clamp } from "../src/util.js";',
	'test("clamp", () => assert.equal(clamp(5, 0, 3), 3));',
);
const PERCENT_TEST = testFile(
	'import { percent } from "../src/percent.js";',
	'test("percent", () => {\n\tassert.equal(percent(1, 4), 25);\n\tassert.equal(percent(5, 4), 100);\n});',
);
const BAR_TEST = testFile(
	'import { progressBar } from "../src/bar.js";',
	'test("bar", () => {\n\tassert.equal(progressBar(0.5, 4), "##--");\n\tassert.equal(progressBar(2, 2), "##");\n});',
);

/**
 * A server on a port of the system's choosing, which it prints once ready. It records that it started, then its port,
 * and whether it gave up waiting to be stopped, beside the fixture, out of the repository: `watch` is graded on that
 * record.
 */
const SERVER = `import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const record = new URL("../server.json", import.meta.url);
writeFileSync(record, "{}");
const server = createServer((_request, response) => response.end("ok"));
server.listen(0, "127.0.0.1", () => {
	const { port } = server.address();
	writeFileSync(record, JSON.stringify({ port }));
	setTimeout(() => console.log(\`READY port=\${port}\`), 2000);
	setTimeout(() => {
		writeFileSync(record, JSON.stringify({ port, expired: true }));
		process.exit(1);
	}, 120_000);
});
`;

/** `watch`'s grade: the port the server printed is in port.txt, and the server was stopped before it gave up. */
function checkWatch(cwd: string): string | undefined {
	const record = join(cwd, "..", "server.json");
	if (!existsSync(record)) return "the server never started";
	const { port, expired } = JSON.parse(readFileSync(record, "utf8"));
	if (port === undefined) return "the server was stopped before it listened";
	if (expired) return "the server was left running until it gave up";
	const written = existsSync(join(cwd, "port.txt")) ? readFileSync(join(cwd, "port.txt"), "utf8").trim() : undefined;
	return written === String(port) ? undefined : `port.txt holds ${JSON.stringify(written)}, not ${port}`;
}

export const SCENARIOS: readonly Scenario[] = [
	{
		name: "trivial",
		files: {
			"package.json": PACKAGE,
			"src/duration.js": 'export function parseDuration(text) {\n\treturn Number(text.replace("s", ""));\n}\n',
			"test/duration.test.js": testFile(
				'import { parseDuration } from "../src/duration.js";',
				'test("seconds", () => assert.equal(parseDuration("5s"), 5));\ntest("minutes", () => assert.equal(parseDuration("2m"), 120));',
			),
		},
		prompt: 'parseDuration in src/duration.js should also read minutes: "2m" is 120. Make `node --test test/` pass.',
		functions: ["parseDuration"],
	},
	{
		name: "investigate",
		files: {
			"package.json": PACKAGE,
			"src/util.js": UTIL,
			"src/percent.js": `import { clamp } from "./util.js";\n\nexport function percent(part, total) {\n\treturn clamp(Math.round((part / total) * 100), 0, 100);\n}\n`,
			"src/bar.js": `import { clamp } from "./util.js";\n\nexport function progressBar(ratio, width) {\n\tconst filled = Math.round(clamp(ratio, 0, 1) * width);\n\treturn "#".repeat(filled) + "-".repeat(width - filled);\n}\n`,
			"src/bytes.js":
				'export function formatBytes(bytes) {\n\treturn bytes < 1024 ? bytes + " B" : Math.round(bytes / 1024) + " KiB";\n}\n',
			"test/util.test.js": UTIL_TEST,
			"test/percent.test.js": PERCENT_TEST,
			"test/bar.test.js": BAR_TEST,
		},
		prompt:
			"Which functions in src/ call clamp, and in which files? Answer with function and file names; change nothing.",
		functions: ["clamp", "percent", "progressBar"],
		answer: /^(?=[\s\S]*\bpercent\b)(?=[\s\S]*\bprogressBar\b)(?=[\s\S]*percent\.js)(?=[\s\S]*bar\.js)/,
	},
	{
		name: "parallel",
		files: {
			"package.json": PACKAGE,
			"src/util.js": UTIL,
			"test/util.test.js": UTIL_TEST,
			"test/percent.test.js": PERCENT_TEST,
			"test/bar.test.js": BAR_TEST,
		},
		prompt:
			'Have two subagents work side by side, one per file: one adds src/percent.js exporting percent(part, total), a whole-number percentage clamped to 0..100; the other adds src/bar.js exporting progressBar(ratio, width), "#" for the filled part and "-" for the rest, with ratio clamped to 0..1. Both must reuse clamp from src/util.js. Bring both changes into this checkout and make `node --test test/` pass.',
		functions: ["clamp", "percent", "progressBar"],
	},
	{
		name: "review",
		files: {
			"package.json": PACKAGE,
			"src/duration.js": "export function parseDuration(text) {\n\treturn Number.NaN;\n}\n",
			"test/duration.test.js": testFile(
				'import { parseDuration } from "../src/duration.js";',
				'test("units", () => {\n\tassert.equal(parseDuration("90s"), 90);\n\tassert.equal(parseDuration("2m"), 120);\n\tassert.equal(parseDuration("1h"), 3600);\n});\ntest("unknown unit", () => assert.throws(() => parseDuration("5x")));',
			),
		},
		prompt:
			'Implement parseDuration in src/duration.js: "90s", "2m" and "1h" in seconds, and an unknown unit throws. Run it as a chain of subagents: one implements it, then a reviewer checks the change. Then have the subagent that implemented it fix what the review found, continuing its own session rather than starting a new subagent. Bring the result into this checkout and make `node --test test/` pass.',
		functions: ["parseDuration"],
	},
	{
		name: "watch",
		files: { "package.json": PACKAGE, "server.js": SERVER },
		prompt:
			"Start the server in server.js (`node server.js`) and keep it running in the background. Once it is up, which takes a few seconds, it prints a line with READY and its port. Tell me when that line appears: do not poll for it. Then write the port number alone to port.txt and stop the server.",
		functions: [],
		check: checkWatch,
		// It measures `monitor`, which is off by default. pi ignores the name in an arm that does not load it.
		tools: ["+monitor"],
	},
	{
		// A limit sent as `10` is 10 ms: the build moves to the background at once and may still finish. The count of
		// bash calls ended at their timeout is this scenario's signal, more than its outcome.
		name: "slow",
		files: {
			"package.json": PACKAGE,
			"build.js":
				'import { mkdirSync, writeFileSync } from "node:fs";\n\nsetTimeout(() => {\n\tmkdirSync(new URL("./dist/", import.meta.url), { recursive: true });\n\twriteFileSync(new URL("./dist/app.txt", import.meta.url), "built\\n");\n\tconsole.log("Built dist/app.txt");\n}, 2000);\n',
			"test/build.test.js": testFile(
				'import { readFileSync } from "node:fs";',
				'test("built", () => assert.equal(readFileSync(new URL("../dist/app.txt", import.meta.url), "utf8"), "built\\n"));',
			),
		},
		prompt:
			"Run the build, `node build.js`; it takes about 2 seconds. Limit it to 10 seconds. Then tell me what it printed.",
		functions: [],
	},
];

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export interface TrialResult {
	arm: Arm;
	scenario: string;
	model: string;
	/**
	 * The fixture's tests pass (or its scenario's check does), each function is defined once, and a question's answer
	 * is right with nothing changed.
	 */
	correct: boolean;
	grade: FixtureGrade;
	/** Why the scenario's check found the outcome wrong. */
	checkFailure?: string;
	/** The parent's tool calls, by tool. */
	toolCalls: Record<string, number>;
	/** The parent's tool calls whose result was an error, of any kind. */
	failedToolCalls: number;
	/** Each failed call as its tool and the first line of its error, to tell what failed once the trial is gone. */
	failedCalls: string[];
	/**
	 * The parent's `bash` calls that ended at their timeout: moved to the background, which is not an error, or
	 * killed. A timeout given in seconds where milliseconds are meant shows here, even when the trial passes.
	 */
	bashTimeouts: number;
	answer: string;
	/** A hash of every file of the final tree but `.git`, to compare arms. */
	finalTree: string;
	wallMs: number;
	/** Model requests of the parent, and how often it started working again without a prompt. */
	parentRequests: number;
	parentWakeups: number;
	parentUsage: Usage;
	/** Every other model session: runs, example children, helpers. */
	childUsage: Usage;
	/** Model sessions besides the parent, by name. */
	childRequests: Record<string, number>;
	/** For each fresh bluclawd run: from its Admission to its pi's session, queue wait included. */
	startupMs: number[];
	/** Model sessions besides the parent that worked outside the checkout: in a worktree. */
	isolated: string[];
	/** Files the parent read or edited that a child also read or edited: an upper bound on duplicated work. */
	overlap: string[];
	/** Paths an Integration refused as conflicting; null where nothing integrates. */
	conflicts: number | null;
	peakProcesses: number;
	/** Processes besides the parent and the daemon still running once the parent settled for good. */
	leftover: number;
	/** It ran past its time or its budget. */
	cutShort: boolean;
	/** Why pi could not do the task at all, such as a model it could not start with. */
	failure?: string;
}

export interface TrialOptions {
	arm: Arm;
	/** The bluclawd checkout a `before` or `after` arm loads its extensions from. */
	checkout?: string;
	scenario: Scenario;
	model: string;
	thinking: string;
	/** Spend real model calls. Without it the model must be a scripted faux one, offline, under a temporary HOME. */
	live?: boolean;
	/** Extensions that register the model's provider, loaded by the parent and, for bluclawd, by its runs. */
	providerExtensions?: string[];
	/** An existing agent dir to use as it is; a fresh one per trial when omitted. */
	agentDir?: string;
	/** The user's auth.json, linked into the trial's fresh agent dir, so a refreshed token is saved to it. */
	auth?: string;
	/** Called with the trial's directories before pi starts: a scripted model's steps go there. */
	prepare?: (dirs: { agentDir: string; cwd: string }) => void;
	/** Stops the trial once its sessions spent more than this many tokens or dollars. */
	limit?: { tokens: number; dollars: number };
	timeoutMs?: number;
}

const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 });

function addUsage(to: Usage, usage: Partial<Omit<Usage, "cost">> & { cost?: number | { total?: number } }): void {
	to.input += usage.input ?? 0;
	to.output += usage.output ?? 0;
	to.cacheRead += usage.cacheRead ?? 0;
	to.cacheWrite += usage.cacheWrite ?? 0;
	to.totalTokens += usage.totalTokens ?? 0;
	to.cost += typeof usage.cost === "number" ? usage.cost : (usage.cost?.total ?? 0);
}

interface SessionLog {
	name: string;
	cwd: string;
	start: number;
	messages: {
		role: string;
		content?: unknown;
		usage?: Usage;
		details?: unknown;
		toolName?: string;
		toolCallId?: string;
		isError?: boolean;
	}[];
}

/** What the parent's tool calls came to: how many of each tool, how many failed, how many `bash` calls timed out. */
function toolOutcomes(messages: SessionLog["messages"]) {
	const toolCalls: Record<string, number> = {};
	const backgrounded = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1;
			if (block.name === "bash" && block.arguments?.run_in_background === true) backgrounded.add(block.id);
		}
	}
	let failedToolCalls = 0;
	const failedCalls: string[] = [];
	let bashTimeouts = 0;
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const text = Array.isArray(message.content) ? message.content.map((block: any) => block.text ?? "").join("") : "";
		if (message.isError) {
			failedToolCalls++;
			failedCalls.push(`${message.toolName}: ${text.trim().split("\n")[0]}`);
		}
		if (message.toolName !== "bash" || backgrounded.has(message.toolCallId ?? "")) continue;
		// Read from the result's shape, not its wording, which the arms may word differently. Nobody presses Ctrl+B or
		// sends a message mid-trial, so a foreground command that went to the background went at its timeout.
		const moved = Boolean((message.details as { backgroundTaskId?: string } | undefined)?.backgroundTaskId);
		// pi's own message, for a command killed at its timeout instead.
		const killed = message.isError === true && /^Command timed out after /m.test(text);
		if (moved || killed) bashTimeouts++;
	}
	return { toolCalls, failedToolCalls, failedCalls, bashTimeouts };
}

function jsonl(path: string): any[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		});
}

function sessionFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? sessionFiles(join(dir, entry.name))
			: entry.name.endsWith(".jsonl")
				? [join(dir, entry.name)]
				: [],
	);
}

function readSession(path: string): SessionLog | undefined {
	const entries = jsonl(path);
	const header = entries[0];
	if (header?.type !== "session") return undefined;
	const messages = entries.filter((e) => e.type === "message").map((e) => e.message);
	return {
		name: entries.find((e) => e.type === "session_info")?.name ?? basename(path),
		cwd: header.cwd,
		start: Date.parse(header.timestamp),
		messages,
	};
}

/** Files read or edited by the tool calls of `messages`, relative to `cwd`. */
function touched(messages: SessionLog["messages"], cwd: string): string[] {
	return messages.flatMap((m) =>
		m.role === "assistant" && Array.isArray(m.content)
			? m.content.flatMap((block: any) =>
					block.type === "toolCall" &&
					["read", "edit", "write"].includes(block.name) &&
					typeof block.arguments?.path === "string"
						? [isAbsolute(block.arguments.path) ? relative(cwd, block.arguments.path) : block.arguments.path]
						: [],
				)
			: [],
	);
}

/**
 * The trial's processes: those whose command line or environment names `base` (`ps eww` shows both), those seen
 * before, and their descendants. A pi that sets its title overwrites both, so it is known by its parent instead.
 */
function processesOf(base: string, known: Set<number>): { pid: number; command: string }[] {
	const listed = spawnSync("ps", ["eww", "-ax", "-o", "pid=,ppid=,command="], {
		encoding: "utf8",
		maxBuffer: 1 << 28,
	});
	const all = (listed.stdout ?? "").split("\n").flatMap((line) => {
		const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
		return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
	});
	// A process gone is forgotten at once, so that its PID, if reused, is not taken for the trial's.
	const alive = new Set(all.map(({ pid }) => pid));
	for (const pid of known) if (!alive.has(pid)) known.delete(pid);
	for (const { pid, command } of all) if (command.includes(base) && pid !== process.pid) known.add(pid);
	for (let grew = true; grew; ) {
		grew = false;
		for (const { pid, ppid } of all)
			if (known.has(ppid) && !known.has(pid)) {
				known.add(pid);
				grew = true;
			}
	}
	return all.filter(({ pid }) => known.has(pid));
}

const isDaemon = (command: string) => command.includes("daemon/cli.ts");

function treeHash(cwd: string): string {
	const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd, encoding: "utf8" })
		.split("\n")
		.filter(Boolean)
		.sort();
	const text = files.map((file) => `${file}\0${existsSync(join(cwd, file)) ? readFileSync(join(cwd, file)) : ""}`);
	return execFileSync("git", ["hash-object", "--stdin"], { input: text.join("\0"), encoding: "utf8" }).trim();
}

/**
 * The example's sample roles, without the model each pins: every arm runs on the model under evaluation. They are
 * user roles bluclawd would take too, so they are there only for the trial: returns what removes them.
 */
function writeExampleRoles(agentDir: string): () => void {
	const dir = join(agentDir, "agents");
	const files = readdirSync(join(EXAMPLE, "agents")).map((file) => join(dir, file));
	const taken = files.filter((path) => existsSync(path));
	if (taken.length > 0) throw new Error(`The example's roles would replace ${taken.join(", ")}`);
	mkdirSync(dir, { recursive: true });
	for (const path of files) {
		const text = readFileSync(join(EXAMPLE, "agents", basename(path)), "utf8");
		writeFileSync(path, text.replace(/^model:.*\n/m, ""));
	}
	return () => {
		for (const path of files) rmSync(path, { force: true });
	};
}

/** Runs one trial in directories of its own, and leaves no process of it running. */
export async function runTrial(options: TrialOptions): Promise<TrialResult> {
	const { arm, live = false } = options;
	if (!live && !options.model.startsWith("faux/")) throw new Error("Without `live`, the model must be a faux one");
	if (!live && arm === "example")
		throw new Error("The example's children have no session name, so a scripted model cannot tell them apart");
	if (options.auth && options.agentDir) throw new Error("`auth` links into a fresh agent dir, not a given one");
	const base = mkdtempSync(join(tmpdir(), "bc-eval-"));
	const agentDir = options.agentDir ?? join(base, "agent");
	const cwd = join(base, "work");
	let removeRoles: (() => void) | undefined;
	let linked = false;
	try {
		for (const dir of [agentDir, cwd, join(base, "s"), join(base, "home")]) mkdirSync(dir, { recursive: true });
		createFixture(options.scenario.files, cwd);
		if (!options.agentDir) {
			const scripted = live ? {} : { compaction: { enabled: false }, retry: { enabled: false } };
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ quietStartup: true, ...scripted }));
		}
		if (options.auth) {
			symlinkSync(options.auth, join(agentDir, "auth.json"));
			linked = true;
		}
		if (arm === "example") removeRoles = writeExampleRoles(agentDir);
		return await trialIn(base, agentDir, cwd, options);
	} finally {
		removeRoles?.();
		// Its trial's processes are gone by now, so nothing writes it any more.
		if (options.auth && linked) keepUnlessLinked(base, agentDir, options.auth);
		rmSync(base, { recursive: true, force: true, maxRetries: 10 });
	}
}

/**
 * Throws, leaving `base` in place, when the agent dir's auth.json is no longer the link to `auth`: whatever pi wrote
 * there in its place may be the only copy of a refreshed credential.
 */
function keepUnlessLinked(base: string, agentDir: string, auth: string): void {
	const path = join(agentDir, "auth.json");
	if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() && readlinkSync(path) === auth) return;
	throw new Error(
		`${path} is no longer a link to ${auth}: pi did not write through it. ${base} is kept. Stop, and ask before using any agent dir.`,
	);
}

/** The environment of a pi of the evaluation, in `agentDir`. Offline and under `home` unless `live`. */
function piEnv(dirs: { agentDir: string; serverDir: string; home: string }, live: boolean): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = Object.fromEntries(
		// The user's bash timeouts would change the tools' text and `slow`'s default.
		Object.entries(process.env).filter(
			([key]) =>
				!/^(BLUCLAWD_|TMUX|PI_SERVER_DIR$|PI_OFFLINE$|BASH_DEFAULT_TIMEOUT_MS$|BASH_MAX_TIMEOUT_MS$)/.test(key),
		),
	);
	Object.assign(env, { PI_CODING_AGENT_DIR: dirs.agentDir, PI_SERVER_DIR: dirs.serverDir });
	if (!live) Object.assign(env, { HOME: dirs.home, PI_OFFLINE: "1" });
	const piRoot = piPackageRoot(PI_CLI);
	if (piRoot) env.PI_PACKAGE_ROOT = piRoot;
	return env;
}

export interface CredentialsCheck {
	provider: string;
	model: string;
	/** pi saved the user's auth.json through the link during the call, as it does when it refreshes a token. */
	writtenThrough: boolean;
}

/**
 * Before a live comparison whose agent dirs link `auth` (the user's auth.json): one small call per provider of
 * `models`, each through a fresh agent dir of that kind, to see that pi writes through the link rather than replacing
 * it. Throws on a failed call or a replaced link, which leaves that agent dir in place.
 */
export async function checkCredentials(options: {
	auth: string;
	models: readonly string[];
	thinking: string;
	/** For a scripted model: offline, with the extension that registers it. */
	providerExtensions?: string[];
}): Promise<CredentialsCheck[]> {
	const live = !options.providerExtensions;
	const firstOfEach = new Map<string, string>();
	for (const model of options.models) {
		const provider = model.split("/")[0];
		if (!firstOfEach.has(provider)) firstOfEach.set(provider, model);
	}
	const checked: CredentialsCheck[] = [];
	for (const [provider, model] of firstOfEach) {
		const base = mkdtempSync(join(tmpdir(), "bc-eval-auth-"));
		const dirs = { agentDir: join(base, "agent"), serverDir: join(base, "s"), home: join(base, "home") };
		for (const dir of Object.values(dirs)) mkdirSync(dir);
		symlinkSync(options.auth, join(dirs.agentDir, "auth.json"));
		// The file's time, not its contents: the credentials are never read here.
		const before = statSync(options.auth).mtimeMs;
		const extensions = (options.providerExtensions ?? []).flatMap((path) => ["-e", path]);
		const args = [
			PI_CLI,
			"-p",
			"--no-session",
			"-ne",
			...extensions,
			"--model",
			model,
			"--thinking",
			options.thinking,
		];
		const call = await new Promise<{ code: number | null; stderr: string }>((done) => {
			const pi = spawn(process.execPath, [...args, "Reply with the single word ok."], {
				cwd: base,
				env: piEnv(dirs, live),
				stdio: ["ignore", "ignore", "pipe"],
			});
			let stderr = "";
			pi.stderr?.on("data", (data) => {
				stderr = (stderr + data).slice(-2000);
			});
			const timer = setTimeout(() => pi.kill("SIGKILL"), 120_000);
			pi.on("exit", (code) => {
				clearTimeout(timer);
				done({ code, stderr });
			});
		});
		keepUnlessLinked(base, dirs.agentDir, options.auth);
		rmSync(base, { recursive: true, force: true, maxRetries: 10 });
		if (call.code !== 0) throw new Error(`The call to ${model} failed: ${call.stderr.trim()}`);
		checked.push({ provider, model, writtenThrough: statSync(options.auth).mtimeMs !== before });
	}
	return checked;
}

async function trialIn(base: string, agentDir: string, cwd: string, options: TrialOptions): Promise<TrialResult> {
	const { arm, scenario, live = false } = options;
	options.prepare?.({ agentDir, cwd });
	// A given agent dir keeps earlier trials' sessions: only this one's count.
	const earlier = new Set(sessionFiles(agentDir));
	const ours = (dir: string) => sessionFiles(dir).filter((path) => !earlier.has(path));

	const env = piEnv({ agentDir, serverDir: join(base, "s"), home: join(base, "home") }, live);
	const providers = options.providerExtensions ?? [];
	if (ARM_SETUP[arm].bluclawd && providers.length > 0) env.BLUCLAWD_RPC_PROVIDER_EXTENSIONS = providers.join(":");
	const extensions = [...providers, ...ARM_SETUP[arm].extensions(options.checkout)].flatMap((path) => ["-e", path]);
	const args = [PI_CLI, "--mode", "rpc", "-ne", ...extensions, "--model", options.model];
	args.push("--thinking", options.thinking);
	if (scenario.tools) args.push("--tools", scenario.tools.join(","));

	const started = Date.now();
	const pi = spawn(process.execPath, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
	const known = new Set(pi.pid ? [pi.pid] : []);
	let agentStarts = 0;
	let idleSince: number | undefined;
	let busySince = Date.now();
	let exited = false;
	pi.on("exit", () => {
		exited = true;
	});
	const send = (record: object) => pi.stdin?.write(`${JSON.stringify(record)}\n`);
	let buffer = "";
	pi.stdout?.on("data", (data) => {
		buffer += data;
		for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
			const line = buffer.slice(0, end).replace(/\r$/, "");
			buffer = buffer.slice(end + 1);
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			if (event.type === "agent_start") {
				agentStarts++;
				idleSince = undefined;
			} else if (event.type === "agent_settled") idleSince = Date.now();
			else if (event.type === "response" && event.command === "prompt" && event.data?.disposition === "handled")
				idleSince = Date.now();
			// Nobody answers a dialog in an evaluation: it is cancelled, as with no user present.
			else if (
				event.type === "extension_ui_request" &&
				["select", "confirm", "input", "editor"].includes(event.method)
			)
				send({ type: "extension_ui_response", id: event.id, cancelled: true });
		}
	});
	let stderr = "";
	pi.stderr?.on("data", (data) => {
		stderr = (stderr + data).slice(-2000);
	});
	send({ id: "prompt", type: "prompt", message: scenario.prompt });

	const sessions = () => ours(agentDir).flatMap((path) => readSession(path) ?? []);
	const spent = () => {
		const usage = emptyUsage();
		for (const session of sessions())
			for (const message of session.messages) if (message.usage) addUsage(usage, message.usage);
		return usage;
	};

	let peakProcesses = 0;
	let cutShort = false;
	let leftover = 0;
	let lastSpendCheck = Date.now();
	const timeoutMs = options.timeoutMs ?? 600_000;
	try {
		for (;;) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			const processes = processesOf(base, known);
			peakProcesses = Math.max(peakProcesses, processes.length);
			const working = processes.filter(({ pid, command }) => pid !== pi.pid && !isDaemon(command));
			// Settled for good: idle for a while with no run left working that could wake it.
			// A background run's Report wakes the parent only once its host is gone: until its record is final, it works.
			const open = runRecords(agentDir).some((record) => record.status && !isTerminalSubagentStatus(record.status));
			if (idleSince === undefined || working.length > 0 || open) busySince = Date.now();
			if (exited || Date.now() - busySince > 1500) break;
			if (Date.now() - started > timeoutMs) {
				cutShort = true;
				leftover = idleSince === undefined ? 0 : working.length;
				break;
			}
			if (options.limit && Date.now() - lastSpendCheck > 2000) {
				lastSpendCheck = Date.now();
				const usage = spent();
				if (usage.totalTokens > options.limit.tokens || usage.cost > options.limit.dollars) {
					cutShort = true;
					break;
				}
			}
		}
	} finally {
		await stop(pi, base, known);
	}
	// Until it settled for good, not until the wait that tells so ended.
	const wallMs = (idleSince ?? Date.now()) - started;
	const failure = exited && idleSince === undefined ? `pi exited before it settled: ${stderr.trim()}` : undefined;

	const parentFiles = ours(join(agentDir, "sessions"));
	const parent = parentFiles.flatMap((path) => readSession(path) ?? [])[0];
	const childSessions = ours(agentDir)
		.filter((path) => !parentFiles.includes(path))
		.flatMap((path) => readSession(path) ?? []);
	const parentUsage = emptyUsage();
	const childUsage = emptyUsage();
	const childRequests: Record<string, number> = {};
	const childTouched = new Set<string>();
	for (const session of childSessions) {
		for (const message of session.messages) {
			if (message.role !== "assistant") continue;
			childRequests[session.name] = (childRequests[session.name] ?? 0) + 1;
			if (message.usage) addUsage(childUsage, message.usage);
		}
		for (const path of touched(session.messages, session.cwd)) childTouched.add(path);
	}
	let parentRequests = 0;
	let answer = "";
	let conflicts: number | null = ARM_SETUP[arm].bluclawd ? 0 : null;
	for (const message of parent?.messages ?? []) {
		if (message.role === "assistant") {
			parentRequests++;
			if (message.usage) addUsage(parentUsage, message.usage);
			const text = Array.isArray(message.content)
				? message.content.flatMap((block: any) => (block.type === "text" ? [block.text] : [])).join("")
				: "";
			if (text) answer = text;
		}
		if (message.role !== "toolResult") continue;
		const text = Array.isArray(message.content) ? message.content.map((block: any) => block.text ?? "").join("") : "";
		if (message.toolName === "subagent_integrate" && conflicts !== null)
			conflicts += Number(/^(\d+) of its changed paths cannot be applied/m.exec(text)?.[1] ?? 0);
		// The example reports its children's turns and usage in the details of its tool's result.
		for (const result of (message.details as any)?.results ?? []) {
			if (!result?.usage) continue;
			const name = `example:${result.agent}`;
			childRequests[name] = (childRequests[name] ?? 0) + (result.usage.turns ?? 0);
			addUsage(childUsage, result.usage);
			for (const path of touched(result.messages ?? [], cwd)) childTouched.add(path);
		}
	}
	const startupMs = runRecords(agentDir).flatMap((record) => {
		const session = childSessions.find((s) => s.name === record.name);
		return session && record.admittedAt && record.admittedAt >= started ? [session.start - record.admittedAt] : [];
	});

	const grade = gradeFixture(cwd, scenario.functions);
	const checkFailure = scenario.check?.(cwd);
	const graded = scenario.check ? checkFailure === undefined : grade.correct;
	const answered = scenario.answer ? scenario.answer.test(answer) && grade.changedFiles.length === 0 : true;
	const result: TrialResult = {
		arm,
		scenario: scenario.name,
		model: options.model,
		correct: graded && answered && !cutShort,
		grade,
		...(checkFailure ? { checkFailure } : {}),
		...toolOutcomes(parent?.messages ?? []),
		answer,
		finalTree: treeHash(cwd),
		wallMs,
		parentRequests,
		parentWakeups: Math.max(0, agentStarts - 1),
		parentUsage,
		childUsage,
		childRequests,
		startupMs,
		isolated: [...new Set(childSessions.filter((s) => s.cwd !== realpathSync(cwd)).map((s) => s.name))].sort(),
		overlap: [...new Set(touched(parent?.messages ?? [], cwd))].filter((path) => childTouched.has(path)).sort(),
		conflicts,
		peakProcesses,
		leftover,
		cutShort,
		...(failure ? { failure } : {}),
	};
	return result;
}

/** Bluclawd runs' records: their names, Admission times and statuses. */
function runRecords(agentDir: string): { name?: string; admittedAt?: number; status?: SubagentLifecycleStatus }[] {
	const dir = join(agentDir, "bluclawd", "subagents");
	if (!existsSync(dir)) return [];
	return readdirSync(dir).flatMap((session) =>
		existsSync(join(dir, session)) && !session.endsWith(".json")
			? readdirSync(join(dir, session)).flatMap((run) => {
					const path = join(dir, session, run, "record.json");
					return existsSync(path) ? [JSON.parse(readFileSync(path, "utf8"))] : [];
				})
			: [],
	);
}

/** Ends pi, then every process of the trial: the daemon, and any run's host and pi. */
async function stop(pi: ChildProcess, base: string, known: Set<number>): Promise<void> {
	const signal = (name: NodeJS.Signals) => {
		for (const { pid } of processesOf(base, known)) {
			try {
				process.kill(pid, name);
			} catch {
				// gone already
			}
		}
	};
	// Its descendants are found before it goes, while they are still its children.
	processesOf(base, known);
	pi.kill("SIGTERM");
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline && processesOf(base, known).length > 0) {
		signal("SIGTERM");
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	signal("SIGKILL");
}

export interface Summary {
	model: string;
	scenario: string;
	arm: Arm;
	trials: number;
	/** Share of single trials that were correct, and of scenarios whose every trial was. */
	passAt1: number | null;
	passAll: number | null;
	medianWallMs: number;
	medianTokens: number;
	medianCost: number;
	medianParentRequests: number;
	maxParentWakeups: number;
	medianStartupMs: number | null;
	maxOverlap: number;
	conflicts: number | null;
	maxPeakProcesses: number;
	maxLeftover: number;
	/** Over every trial: the parent's failed tool calls and `bash` calls ended at their timeout, and the tools it called. */
	failedToolCalls: number;
	bashTimeouts: number;
	tools: string[];
}

const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted.length === 0 ? Number.NaN : sorted[Math.floor((sorted.length - 1) / 2)];
};

export function summarize(results: readonly TrialResult[]): Summary[] {
	const keys = [...new Set(results.map((r) => `${r.model}\0${r.scenario}\0${r.arm}`))];
	return keys.map((key) => {
		const [model, scenario, arm] = key.split("\0") as [string, string, Arm];
		const trials = results.filter((r) => r.model === model && r.scenario === scenario && r.arm === arm);
		const outcomes = [trials.map((r) => r.correct)];
		const startups = trials.flatMap((r) => r.startupMs);
		const conflicts = trials.map((r) => r.conflicts);
		return {
			model,
			scenario,
			arm,
			trials: trials.length,
			passAt1: passPowerK(outcomes, 1),
			passAll: passPowerK(outcomes, trials.length),
			medianWallMs: median(trials.map((r) => r.wallMs)),
			medianTokens: median(trials.map((r) => r.parentUsage.totalTokens + r.childUsage.totalTokens)),
			medianCost: median(trials.map((r) => r.parentUsage.cost + r.childUsage.cost)),
			medianParentRequests: median(trials.map((r) => r.parentRequests)),
			maxParentWakeups: Math.max(...trials.map((r) => r.parentWakeups)),
			medianStartupMs: startups.length > 0 ? median(startups) : null,
			maxOverlap: Math.max(...trials.map((r) => r.overlap.length)),
			conflicts: conflicts.includes(null) ? null : conflicts.reduce((sum: number, n) => sum + (n ?? 0), 0),
			maxPeakProcesses: Math.max(...trials.map((r) => r.peakProcesses)),
			maxLeftover: Math.max(...trials.map((r) => r.leftover)),
			failedToolCalls: trials.reduce((sum, r) => sum + r.failedToolCalls, 0),
			bashTimeouts: trials.reduce((sum, r) => sum + r.bashTimeouts, 0),
			tools: [...new Set(trials.flatMap((r) => Object.keys(r.toolCalls)))].sort(),
		};
	});
}

/** The summary as a Markdown table. */
export function formatSummary(rows: readonly Summary[]): string {
	const columns: [string, (row: Summary) => unknown][] = [
		["model", (r) => r.model],
		["scenario", (r) => r.scenario],
		["arm", (r) => r.arm],
		["trials", (r) => r.trials],
		["pass@1", (r) => r.passAt1?.toFixed(2) ?? "n/a"],
		["pass^k", (r) => r.passAll?.toFixed(2) ?? "n/a"],
		["wall ms", (r) => r.medianWallMs],
		["tokens", (r) => r.medianTokens],
		["cost $", (r) => r.medianCost.toFixed(4)],
		["parent requests", (r) => r.medianParentRequests],
		["wakeups", (r) => r.maxParentWakeups],
		["run startup ms", (r) => r.medianStartupMs ?? "n/a"],
		["overlap", (r) => r.maxOverlap],
		["conflicts", (r) => r.conflicts ?? "n/a"],
		["peak procs", (r) => r.maxPeakProcesses],
		["leftover", (r) => r.maxLeftover],
		["failed calls", (r) => r.failedToolCalls],
		["bash timeouts", (r) => r.bashTimeouts],
		["tools", (r) => r.tools.join(", ")],
	];
	return [
		`| ${columns.map(([name]) => name).join(" | ")} |`,
		`|${columns.map(() => "---").join("|")}|`,
		...rows.map((row) => `| ${columns.map(([, value]) => String(value(row))).join(" | ")} |`),
	].join("\n");
}

function flag(argv: string[], name: string): string | undefined {
	const at = argv.indexOf(`--${name}`);
	return at >= 0 ? argv[at + 1] : undefined;
}

const USAGE = `Usage: node scripts/eval-delegation.ts --live --models <provider/id>[,<provider/id>...] --thinking <level>
  --max-tokens <n> --max-dollars <n> [--trials 3] [--before <checkout> --after <checkout>]
  [--arms stock,bluclawd,example|before,after] [--scenarios trivial,investigate,parallel,review,watch,slow]
  [--auth <auth.json> | --agent-dir <dir>] [--out <results.json>]
It spends real model calls, within the budget given, which covers every model.`;

async function main(argv: string[]): Promise<void> {
	const models = (flag(argv, "models") ?? flag(argv, "model"))?.split(",");
	const thinking = flag(argv, "thinking");
	const maxTokens = Number(flag(argv, "max-tokens"));
	const maxDollars = Number(flag(argv, "max-dollars"));
	const checkouts: Partial<Record<Arm, string>> = {};
	for (const arm of ["before", "after"] as const) {
		const checkout = flag(argv, arm);
		if (checkout) checkouts[arm] = resolve(checkout);
	}
	const auth = flag(argv, "auth");
	const agentDir = flag(argv, "agent-dir");
	if (
		!argv.includes("--live") ||
		!models ||
		!thinking ||
		!(maxTokens > 0) ||
		!(maxDollars > 0) ||
		(auth && agentDir)
	) {
		console.error(USAGE);
		process.exitCode = 2;
		return;
	}
	const trials = Number(flag(argv, "trials") ?? 3);
	const arms = (flag(argv, "arms")?.split(",") ??
		(checkouts.before || checkouts.after ? ["before", "after"] : ARMS)) as Arm[];
	const names = flag(argv, "scenarios")?.split(",");
	const scenarios = SCENARIOS.filter((s) => !names || names.includes(s.name));
	const budget = new EvaluationBudget(models.length * trials * arms.length * scenarios.length, maxTokens, maxDollars);
	const perTrial = { tokens: maxTokens / 4, dollars: maxDollars / 4 };
	const results: TrialResult[] = [];
	try {
		// A checkout the arm cannot load is said before any call is spent.
		for (const arm of arms) ARM_SETUP[arm].extensions(checkouts[arm]);
		if (auth && !existsSync(auth)) throw new Error(`No auth.json at ${auth}`);
		if (auth) {
			for (const check of await checkCredentials({ auth: resolve(auth), models, thinking })) {
				const saved = check.writtenThrough ? ", and pi saved auth.json through the link" : "";
				console.error(`Credentials: ${check.provider} answered on ${check.model}${saved}.`);
			}
		}
		for (const model of models) {
			for (let trial = 0; trial < trials; trial++) {
				for (const scenario of scenarios) {
					for (const arm of arms) {
						// Each trial reserves a quarter of the budget and is stopped past it; what it leaves unspent returns.
						const settle = budget.reserve(perTrial.tokens, perTrial.dollars);
						const result = await runTrial({
							arm,
							checkout: checkouts[arm],
							scenario,
							model,
							thinking,
							live: true,
							agentDir,
							auth: auth && resolve(auth),
							limit: perTrial,
						});
						settle(
							result.parentUsage.totalTokens + result.childUsage.totalTokens,
							result.parentUsage.cost + result.childUsage.cost,
						);
						results.push(result);
						console.error(
							`${model} ${scenario.name} ${arm} #${trial + 1}: ${result.correct ? "correct" : "incorrect"}, ${result.failedToolCalls} failed calls, ${result.bashTimeouts} bash timeouts`,
						);
						// Not a wrong answer: the setup is wrong, and every later trial would fail the same way.
						if (result.failure) throw new Error(result.failure);
					}
				}
			}
		}
	} catch (error) {
		console.error(`Stopped: ${error instanceof Error ? error.message : String(error)}`);
	}
	const out = flag(argv, "out");
	if (out) writeFileSync(out, JSON.stringify({ models, thinking, trials, checkouts, results }, null, 2));
	console.log(formatSummary(summarize(results)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main(process.argv.slice(2));
