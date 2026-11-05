/**
 * Real pi processes in a private tmux server, as agent view runs them: each pane is an interactive
 * pi on the faux model of test/fixtures/real-pi/faux.ts, with a private daemon. Every pi it starts,
 * the panes' own included, loads the extensions from the agent dir's settings, as installed
 * packages load. Without tmux there is nothing to run: guard with `describe.skipIf(!hasTmux)`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { type InstanceSummary, OrchestratorClient } from "../../daemon/orchestrator-client.ts";
import { Tmux } from "../../daemon/tmux.ts";
import { type FauxStep, fauxDir } from "../fixtures/real-pi/faux.ts";
import { waitFor } from "./wait-for.ts";

export type { FauxStep };

export const hasTmux = Tmux.available();

const root = fileURLToPath(new URL("../..", import.meta.url));
const PI_CLI = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");
const FAUX = fileURLToPath(new URL("../fixtures/real-pi/faux.ts", import.meta.url));
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
	model: string;
	reasoning?: string;
	messages: FauxMessage[];
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
	/** Ends the daemon and every pane, and removes their directories. */
	stop(): Promise<void>;
}

/**
 * A private tmux server, daemon and agent dir, set in this process's environment (stubbed, so
 * vitest restores it) before anything reads them: the tmux server, and so every pane, inherits
 * them. HOME is a temporary one too, so no pane reads the user's own skills or settings.
 */
export async function startRealPi(options: { extensions?: string[] } = {}): Promise<RealPi> {
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
	const extensions = (options.extensions ?? DEFAULT_EXTENSIONS).map((name) => join(root, "ext", name, "index.ts"));
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			extensions: [FAUX, ...extensions],
			quietStartup: true,
			compaction: { enabled: false },
			retry: { enabled: false },
		}),
	);
	const tmux = new Tmux(serverDir);
	const client = new OrchestratorClient();
	if (!(await client.ensureDaemon())) throw new Error("the test daemon did not start");

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
		stop: async () => {
			await client.shutdownDaemon();
			spawnSync("tmux", ["-S", tmux.socket, "kill-server"]);
			rmSync(base, { recursive: true, force: true });
		},
	};
}
