/**
 * Real pi processes in a private tmux server, as agent view runs them: each pane is an interactive
 * pi on the faux model of test/fixtures/real-pi/faux.ts, with a private daemon. Every pi it starts,
 * the panes' own included, loads the extensions from the agent dir's settings, as installed
 * packages load. Without tmux there is nothing to run: guard with `describe.skipIf(!hasTmux)`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { type InstanceSummary, OrchestratorClient, piPackageRoot } from "../../daemon/orchestrator-client.ts";
import { Tmux } from "../../daemon/tmux.ts";
import { type FauxStep, fauxDir } from "../fixtures/real-pi/faux.ts";
import { installedPiHost } from "./pi-host.ts";
import { waitFor } from "./wait-for.ts";

export type { FauxStep };

export const hasTmux = Tmux.available();
// Refuses a host whose packages mix versions before any pane starts.
installedPiHost();

const root = fileURLToPath(new URL("../..", import.meta.url));
export const PI_CLI = join(
	dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
	"bundle/cli.js",
);
export const FAUX = fileURLToPath(new URL("../fixtures/real-pi/faux.ts", import.meta.url));
/** bluclawd's extensions a pane loads by default. */
export const DEFAULT_EXTENSIONS = ["agent-view", "subagents"];

/** A message of a faux request, as pi sent it to the model. */
export interface FauxMessage {
	role: "system" | "user" | "assistant" | "toolResult";
	content: string | Array<{ type: string; text?: string; name?: string }>;
	sections?: Record<string, string | null>;
	toolsAdded?: Array<{ name: string }>;
	toolsRemoved?: Array<{ name: string }>;
	toolName?: string;
	details?: unknown;
}

/** One request a session's model got. */
export interface FauxRequest {
	piVersion: string;
	provider: string;
	model: string;
	reasoning?: string;
	messages: FauxMessage[];
}

/** Kills each process, if it still runs. */
function killAll(pids: number[]): void {
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// gone already
		}
	}
}

/**
 * What still runs on files under `base` once the tmux servers are gone: the pis' hand-offs, and the RPC runs' hosts
 * and pis, which outlive the pane that launched them.
 */
function leftovers(base: string): number[] {
	return spawnSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" })
		.stdout.split("\n")
		.filter((line) => line.includes(basename(base)))
		.map((line) => Number.parseInt(line, 10))
		.filter((pid) => pid !== process.pid);
}

function textOf(content: FauxMessage["content"]): string {
	return typeof content === "string" ? content : content.map((block) => block.text ?? "").join("");
}

/** The system prompt the model was given, sections included. */
export function systemPrompt(request: FauxRequest): string {
	return request.messages
		.filter((m) => m.role === "system")
		.map((m) => [textOf(m.content), ...Object.values(m.sections ?? {}).filter((s) => s !== null)].join("\n"))
		.join("\n");
}

/** The tools the model could call. */
export function toolNames(request: FauxRequest): string[] {
	const tools = new Set<string>();
	for (const m of request.messages) {
		for (const tool of m.toolsAdded ?? []) tools.add(tool.name);
		for (const tool of m.toolsRemoved ?? []) tools.delete(tool.name);
	}
	return [...tools].sort();
}

/** The model's view of the conversation, without the system messages: role and text. */
export function conversation(request: FauxRequest): Array<{ role: string; text: string; toolName?: string }> {
	return request.messages
		.filter((m) => m.role !== "system")
		.map((m) => ({ role: m.role, text: textOf(m.content), ...(m.toolName ? { toolName: m.toolName } : {}) }));
}

export interface RealPi {
	tmux: Tmux;
	client: OrchestratorClient;
	agentDir: string;
	cwd: string;
	/** Set the faux model's steps for the session named `session` (`main`: one without a name). */
	script(session: string, steps: FauxStep[]): void;
	/** The requests the model of `session` got so far. */
	requests(session: string): FauxRequest[];
	/** Waits until the model of `session` got `count` requests, and returns them; a timeout's error
	 *  holds every pane's screen. */
	waitForRequests(session: string, count: number): Promise<FauxRequest[]>;
	/** Start a pane's pi on faux-1 with `args`; returns its tmux session. */
	start(args?: string[]): string;
	/** The daemon's rows. */
	rows(): Promise<InstanceSummary[]>;
	/** Every pane's screen, scrollback included: for a failing test to show. */
	screens(): string;
	/** Shows `pane` in a terminal of its own (a client of the private server), as `pi` in a terminal does. */
	attach(pane: string): void;
	/** The pane that terminal shows now. */
	shown(): string | undefined;
	/** Ends the daemon and every pane, and removes their directories. */
	stop(): Promise<void>;
}

/**
 * A private tmux server, daemon and agent dir, set in this process's environment (stubbed, so
 * vitest restores it) before anything reads them: the tmux server, and so every pane, inherits
 * them. HOME is a temporary one too, so no pane reads the user's own skills or settings.
 */
export async function startRealPi(
	options: { extensions?: string[]; runsInPanes?: boolean; defaultTools?: string[] } = {},
): Promise<RealPi> {
	const base = mkdtempSync(join(tmpdir(), "bc-real-"));
	const serverDir = join(base, "s");
	const agentDir = join(base, "agent");
	const cwd = join(base, "work");
	const home = join(base, "home");
	for (const dir of [serverDir, agentDir, cwd, home, fauxDir(agentDir)]) mkdirSync(dir, { recursive: true });
	vi.stubEnv("PI_SERVER_DIR", serverDir);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("HOME", home);
	vi.stubEnv("PI_OFFLINE", "1");
	// The daemon's build is told by pi's package as well: one started from here without it is taken for stale
	// by a quitting pane's hand-off, which restarts it and drops every registration meanwhile.
	const piRoot = piPackageRoot(PI_CLI);
	if (piRoot) vi.stubEnv("PI_PACKAGE_ROOT", piRoot);
	const extensions = (options.extensions ?? DEFAULT_EXTENSIONS).map((name) => join(root, "ext", name, "index.ts"));
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			extensions: [FAUX, ...extensions],
			quietStartup: true,
			compaction: { enabled: false },
			retry: { enabled: false },
			// Runs on pi's RPC unless a test opts in to panes (ADR-0013), the default for the user.
			...(options.runsInPanes ? {} : { subagents: { panes: false } }),
			...(options.defaultTools ? { defaultTools: options.defaultTools } : {}),
		}),
	);
	// A stored credential, as a real provider has: without one, pi 1.5.2 may resume a session before it has checked
	// the faux provider's auth, and the session is left without a model (#318).
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "faux" } }));
	const tmux = new Tmux(serverDir);
	const terminal = join(base, "t.sock");
	const client = new OrchestratorClient();
	// ensureDaemon waits 3s, too short under parallel load; calling it again would spawn a second daemon.
	if (!(await client.ensureDaemon())) await waitFor(async () => expect(await client.isRunning()).toBe(true));

	const requests = (session: string): FauxRequest[] => {
		const log = join(fauxDir(agentDir), `${session}.requests.jsonl`);
		if (!existsSync(log)) return [];
		return readFileSync(log, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as FauxRequest);
	};
	/** Every pane's screen: a pi that never asked its model says why there. */
	const screens = (): string => {
		const listed = spawnSync("tmux", ["-S", tmux.socket, "list-sessions", "-F", "#{session_name}"], {
			encoding: "utf8",
		});
		return listed.stdout
			.split("\n")
			.filter(Boolean)
			.map((pane) => `--- ${pane} ---\n${tmux.capture(pane, 200).join("\n")}`)
			.join("\n");
	};

	return {
		tmux,
		client,
		agentDir,
		cwd,
		script: (session, steps) => writeFileSync(join(fauxDir(agentDir), `${session}.json`), JSON.stringify(steps)),
		requests,
		waitForRequests: async (session, count) => {
			try {
				await waitFor(() => expect(requests(session)).toHaveLength(count));
			} catch (error) {
				throw new Error(`${error instanceof Error ? error.message : String(error)}\n${screens()}`);
			}
			return requests(session);
		},
		// The model by flag, not by the settings: pi may resolve those before the faux provider is registered.
		start: (args = []) =>
			tmux.newSession({ cwd, args: ["--model", "faux/faux-1", ...args], command: [process.execPath, PI_CLI] }),
		rows: () => client.list(),
		screens,
		// The terminal is a pane of another tmux server, running a client of the private one.
		attach: (pane) => {
			const attach = `env -u TMUX tmux -S '${tmux.socket}' attach-session -t '=${pane}'`;
			spawnSync("tmux", ["-S", terminal, "-f", "/dev/null", "new-session", "-d", "-x", "120", "-y", "40", attach]);
		},
		shown: () =>
			spawnSync("tmux", ["-S", tmux.socket, "list-clients", "-F", "#{client_session}"], { encoding: "utf8" })
				.stdout.split("\n")
				.find(Boolean),
		stop: async () => {
			const pis = spawnSync("tmux", ["-S", tmux.socket, "list-panes", "-a", "-F", "#{pane_pid}"], {
				encoding: "utf8",
			})
				.stdout.split("\n")
				.filter(Boolean)
				.map(Number);
			// A hung-up pi hands its session to the daemon once it has exited (hand-off.ts), starting a daemon if
			// none runs, which would outlive the test. Killed outright, a pi hands nothing off; a hand-off from a
			// run closed earlier is killed before the daemon goes, and so is an RPC run's host and pi.
			killAll(pis);
			spawnSync("tmux", ["-S", tmux.socket, "kill-server"]);
			spawnSync("tmux", ["-S", terminal, "kill-server"]);
			killAll(leftovers(base));
			await client.shutdownDaemon();
			rmSync(base, { recursive: true, force: true, maxRetries: 10 });
		},
	};
}
