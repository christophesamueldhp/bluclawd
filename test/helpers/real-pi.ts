import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { type InstanceSummary, OrchestratorClient, piPackageRoot } from "../../daemon/orchestrator-client.ts";
import { Tmux } from "../../daemon/tmux.ts";
import { type FauxStep, fauxDir } from "../fixtures/real-pi/faux.ts";
import { readinessMs } from "./heartbeats.ts";
import { sigkillIfAlive } from "./leaderless-group.ts";
import { installedPiHost } from "./pi-host.ts";
import { waitFor, waitWhileProgressing } from "./wait-for.ts";

export type { FauxStep };

export const hasTmux = Tmux.available();
installedPiHost();

const root = fileURLToPath(new URL("../..", import.meta.url));
export const PI_CLI = join(
	dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
	"bundle/cli.js",
);
export const FAUX = fileURLToPath(new URL("../fixtures/real-pi/faux.ts", import.meta.url));
export const DEFAULT_EXTENSIONS = ["agent-view", "subagents"];

export interface FauxMessage {
	role: "system" | "user" | "assistant" | "toolResult";
	content: string | Array<{ type: string; text?: string; name?: string }>;
	sections?: Record<string, string | null>;
	toolsAdded?: Array<{ name: string }>;
	toolsRemoved?: Array<{ name: string }>;
	toolName?: string;
	details?: unknown;
}

export interface FauxRequest {
	piVersion: string;
	provider: string;
	model: string;
	reasoning?: string;
	messages: FauxMessage[];
}

function killAll(pids: number[]): void {
	for (const pid of pids) sigkillIfAlive(pid);
}

export const isZombie = (stat: string): boolean => stat.startsWith("Z");

const psEnvWithoutBase = () => ({ PATH: process.env.PATH });
const PS_LISTING_MAX_BYTES = 256 * 1024 * 1024;
const RELIST_PAUSE_MS = 100;

type Listed = { pid: number; group: number; named: boolean };

function processes(base: string): Listed[] {
	const listed = spawnSync("ps", ["axeww", "-o", "pid=,pgid=,stat=,command="], {
		encoding: "utf8",
		env: psEnvWithoutBase(),
		maxBuffer: PS_LISTING_MAX_BYTES,
	});
	if (listed.status !== 0) throw new Error(`ps failed: ${listed.error ?? listed.stderr}`);
	return listed.stdout.split("\n").flatMap((line) => {
		const [pid, group, stat] = line.trim().split(/\s+/, 3);
		if (!stat || isZombie(stat)) return [];
		return [{ pid: Number(pid), group: Number(group), named: line.includes(basename(base)) }];
	});
}

function dropEmptiedGroups(ours: Set<number>, listed: Listed[]): void {
	for (const group of ours) if (!listed.some((entry) => entry.group === group)) ours.delete(group);
}

export async function endLeftovers(base: string, groups: number[] = []): Promise<void> {
	const ours = new Set(groups);
	const deadline = Date.now() + readinessMs;
	for (;;) {
		const listed = processes(base);
		const byPid = new Map(listed.map((entry) => [entry.pid, entry]));
		const testRunGroup = byPid.get(process.pid)?.group;
		if (testRunGroup === undefined)
			throw new Error(`ps did not list this process (${process.pid}): its group is unknown`);
		dropEmptiedGroups(ours, listed);
		const ledByUnnamedProcess = (group: number) => byPid.get(group)?.named === false;
		for (const { group, named } of listed) {
			if (!named || group <= 1 || group === testRunGroup) continue;
			if (!ledByUnnamedProcess(group)) ours.add(group);
		}
		const left = listed.filter(({ pid, group, named }) => pid !== process.pid && (named || ours.has(group)));
		if (left.length === 0) return;
		const pids = left.map(({ pid }) => pid);
		if (Date.now() > deadline) {
			const survivors = spawnSync("ps", ["-o", "pid=,command=", "-p", pids.join(",")], { encoding: "utf8" });
			throw new Error(`still running ${readinessMs}ms into the teardown of ${base}:\n${survivors.stdout}`);
		}
		killAll(pids);
		await new Promise((resolve) => setTimeout(resolve, RELIST_PAUSE_MS));
	}
}

function textOf(content: FauxMessage["content"]): string {
	return typeof content === "string" ? content : content.map((block) => block.text ?? "").join("");
}

export function systemPrompt(request: FauxRequest): string {
	return request.messages
		.filter((m) => m.role === "system")
		.map((m) => [textOf(m.content), ...Object.values(m.sections ?? {}).filter((s) => s !== null)].join("\n"))
		.join("\n");
}

export function toolNames(request: FauxRequest): string[] {
	const tools = new Set<string>();
	for (const m of request.messages) {
		for (const tool of m.toolsAdded ?? []) tools.add(tool.name);
		for (const tool of m.toolsRemoved ?? []) tools.delete(tool.name);
	}
	return [...tools].sort();
}

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
	script(session: string, steps: FauxStep[]): void;
	requests(session: string): FauxRequest[];
	waitForRequests(session: string, count: number): Promise<FauxRequest[]>;
	start(args?: string[]): string;
	rows(): Promise<InstanceSummary[]>;
	screens(): string;
	attach(pane: string): void;
	shown(): string | undefined;
	stop(): Promise<void>;
}

function stubDaemonBuildIdentity(): void {
	const piRoot = piPackageRoot(PI_CLI);
	if (piRoot) vi.stubEnv("PI_PACKAGE_ROOT", piRoot);
}

function killPanePisWithoutHandOff(tmux: Tmux): number[] {
	const pis = spawnSync("tmux", ["-S", tmux.socket, "list-panes", "-a", "-F", "#{pane_pid}"], {
		encoding: "utf8",
	})
		.stdout.split("\n")
		.filter(Boolean)
		.map(Number);
	killAll(pis);
	return pis;
}

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
	stubDaemonBuildIdentity();
	const extensions = (options.extensions ?? DEFAULT_EXTENSIONS).map((name) => join(root, "ext", name, "index.ts"));
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			extensions: [FAUX, ...extensions],
			quietStartup: true,
			compaction: { enabled: false },
			retry: { enabled: false },
			...(options.runsInPanes ? {} : { subagents: { panes: false } }),
			...(options.defaultTools ? { defaultTools: options.defaultTools } : {}),
		}),
	);
	// A stored credential, as a real provider has. Without one, pi 1.5.2 may resume a session before it has checked
	// the faux provider's auth, and the session is left without a model (#318).
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "faux" } }));
	const tmux = new Tmux(serverDir);
	const terminal = join(base, "t.sock");
	const client = new OrchestratorClient();
	const stop = async (): Promise<void> => {
		const pis = killPanePisWithoutHandOff(tmux);
		spawnSync("tmux", ["-S", tmux.socket, "kill-server"]);
		spawnSync("tmux", ["-S", terminal, "kill-server"]);
		try {
			await endLeftovers(base, pis);
		} finally {
			rmSync(base, { recursive: true, force: true, maxRetries: 10 });
		}
	};
	try {
		if (!(await client.ensureDaemon())) await waitFor(async () => expect(await client.isRunning()).toBe(true));
	} catch (error) {
		try {
			await stop();
		} catch (stopError) {
			throw new AggregateError([error, stopError], "the real pi failed to start, and so did its teardown");
		}
		throw error;
	}

	const requests = (session: string): FauxRequest[] => {
		const log = join(fauxDir(agentDir), `${session}.requests.jsonl`);
		if (!existsSync(log)) return [];
		return readFileSync(log, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as FauxRequest);
	};
	const requestBytes = (): number =>
		readdirSync(fauxDir(agentDir))
			.filter((file) => file.endsWith(".requests.jsonl"))
			.reduce((bytes, file) => bytes + statSync(join(fauxDir(agentDir), file)).size, 0);
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
				await waitWhileProgressing(() => expect(requests(session)).toHaveLength(count), requestBytes);
			} catch (error) {
				throw new Error(`${error instanceof Error ? error.message : String(error)}\n${screens()}`);
			}
			return requests(session);
		},
		start: (args = []) =>
			tmux.newSession({ cwd, args: ["--model", "faux/faux-1", ...args], command: [process.execPath, PI_CLI] }),
		rows: () => client.list(),
		screens,
		attach: (pane) => {
			const attach = `env -u TMUX tmux -S '${tmux.socket}' attach-session -t '=${pane}'`;
			spawnSync("tmux", ["-S", terminal, "-f", "/dev/null", "new-session", "-d", "-x", "120", "-y", "40", attach]);
		},
		shown: () =>
			spawnSync("tmux", ["-S", tmux.socket, "list-clients", "-F", "#{client_session}"], { encoding: "utf8" })
				.stdout.split("\n")
				.find(Boolean),
		stop,
	};
}
