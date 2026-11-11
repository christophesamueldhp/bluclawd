import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { descendantCommand, leavingBehind, readHeartbeats, readinessMs } from "./helpers/heartbeats.ts";
import {
	conversation,
	FAUX,
	type FauxRequest,
	hasTmux,
	type RealPi,
	startRealPi,
	toolNames,
} from "./helpers/real-pi.ts";
import { waitFor } from "./helpers/wait-for.ts";

/** Shell commands of a run are contained only where a backend can confirm their processes ended. */
const contained = process.platform === "darwin";

const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

/** A run's directory, as its orchestrator stored it, by the run's name. */
function runDir(agentDir: string, name: string): string {
	const root = join(agentDir, "bluclawd", "subagents");
	for (const session of readdirSync(root)) {
		for (const run of readdirSync(join(root, session))) {
			const record = join(root, session, run, "record.json");
			if (existsSync(record) && readJson(record).name === name) return join(root, session, run);
		}
	}
	throw new Error(`no run named ${name}`);
}

const recordOf = (real: RealPi, name: string) => readJson(join(runDir(real.agentDir, name), "record.json"));
const worktreeOf = (real: RealPi, name: string) =>
	join(realpathSync(real.agentDir), "bluclawd", "worktrees", recordOf(real, name).runId);

/** The text of each tool result the model was given, in order. */
const toolResults = (request: FauxRequest) =>
	conversation(request)
		.filter((message) => message.role === "toolResult")
		.map((message) => message.text);

const unwrapped = (real: RealPi, pane: string) => real.tmux.capture(pane, 80).join("").replace(/\s+/g, "");
const squeezed = (text: string) => text.replace(/\s+/g, "");

/** Git in `cwd` as the fixture's user. */
function git(cwd: string, ...args: string[]): string {
	const result = spawnSync(
		"git",
		["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args],
		{ cwd, encoding: "utf8" },
	);
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
}

/** Whether nothing more beats into `path` over the next 300ms, after something had. */
async function quietAfterBeats(path: string): Promise<{ started: boolean; quiet: boolean }> {
	const before = readHeartbeats(path).length;
	await new Promise((resolve) => setTimeout(resolve, 300));
	return { started: before > 0, quiet: readHeartbeats(path).length === before };
}

/** An orchestrator pane in a Git checkout, whose runs are RPC children. */
async function startOrchestrator(): Promise<RealPi> {
	vi.stubEnv("BLUCLAWD_RPC_RUNS", "1");
	vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", FAUX);
	const real = await startRealPi();
	writeFileSync(join(real.cwd, "a.txt"), "one\n");
	git(real.cwd, "init", "-q");
	git(real.cwd, "add", ".");
	git(real.cwd, "commit", "-q", "-m", "start");
	return real;
}

/** Kills the pi in `pane` as a crash does: it never ends its session, and its pane goes with it. */
function crash(real: RealPi, pane: string): void {
	const pid = Number(
		spawnSync("tmux", ["-S", real.tmux.socket, "display-message", "-p", "-t", `=${pane}:`, "#{pane_pid}"], {
			encoding: "utf8",
		}).stdout.trim(),
	);
	// Never 0, which would kill this whole process group.
	expect(pid).toBeGreaterThan(0);
	process.kill(pid, "SIGKILL");
}

/** A command whose double-forked descendant, with no environment but PATH, beats into `path` for minutes. */
const escaping = (path: string, identity: string) =>
	`env -i PATH=/usr/bin:/bin ${descendantCommand("double-fork", path, identity, 4 * readinessMs)}`;

describe.skipIf(!hasTmux || !contained)("a run's shell on pi's RPC", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	it("runs commands in its own worktree's sandbox: it writes there, reaches neither its checkout nor the daemon, and nothing it started outlives a command", async () => {
		const real = await startOrchestrator();
		pi = real;
		const checkout = realpathSync(real.cwd);
		const socket = join(process.env.PI_SERVER_DIR ?? "", "server.sock");
		const connect = `${quote(process.execPath)} -e ${quote(`require("net").connect(${JSON.stringify(socket)}).on("connect", () => { console.log("CONNECTED"); process.exit(0); }).on("error", (e) => { console.log(e.code); process.exit(1); })`)}`;
		real.script("main", [
			{ tool: "subagent", args: { agent: "general-purpose", name: "gp", task: "Make it." } },
			{ text: "done" },
		]);
		real.script("gp", [
			{
				tool: "bash",
				args: {
					command:
						'printf made > made.txt && cat a.txt && printf "[%s|%s|%s]" "$PI_SERVER_DIR" "$TMUX" "$TMUX_PANE"',
				},
			},
			{ tool: "bash", args: { command: `printf x > ${quote(join(checkout, "escaped.txt"))}` } },
			{ tool: "bash", args: { command: connect } },
			{ tool: "bash", args: { command: leavingBehind(escaping("beats.jsonl", "gp-left"), "beats.jsonl") } },
			{
				tool: "bash",
				args: {
					command: `printf "require('node:test')('adds', () => require('node:assert').equal(1 + 1, 2));\\n" > sum.test.js && ${quote(process.execPath)} --test sum.test.js && git status --short`,
				},
			},
			{ text: "Made it." },
		]);
		real.start(["--", "delegate"]);
		const main = await real.waitForRequests("main", 2);

		const gp = real.requests("gp");
		expect(gp).toHaveLength(6);
		// The bundled role that implements changes runs commands here, besides editing.
		expect(toolNames(gp[0])).toEqual(expect.arrayContaining(["bash", "edit", "write", "read"]));
		const [made, escaped, daemon, , tested] = toolResults(gp[5]);
		// Its pi is told of neither the daemon's nor tmux's endpoints.
		expect(made).toBe("one\n[||]");
		expect(escaped).toMatch(/Operation not permitted/);
		expect(existsSync(join(checkout, "escaped.txt"))).toBe(false);
		// The daemon this test runs listens there, and the run's command cannot reach it by its path.
		await expect(real.rows()).resolves.toBeDefined();
		expect(daemon).not.toContain("CONNECTED");

		// A test runner, and the processes it starts, run there too, and Git reads the worktree.
		expect(tested).toMatch(/pass 1\n/);
		expect(tested).toMatch(/\?\? made\.txt/);
		const report = toolResults(main[1]).at(-1);
		expect(report).toMatch(/Changes since its baseline: .*A made\.txt/);
		expect(git(checkout, "status", "--porcelain")).toBe("");
		// What its command left running ended with that command, before the run went on.
		expect(await quietAfterBeats(join(worktreeOf(real, "gp"), "beats.jsonl"))).toEqual({
			started: true,
			quiet: true,
		});
	});

	it("is stopped only once every process its command started has ended, wherever it went", async () => {
		const real = await startOrchestrator();
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "general-purpose", name: "gp", task: "Run it." } },
			{ text: "stopped" },
		]);
		real.script("gp", [
			{ tool: "bash", args: { command: `${escaping("beats.jsonl", "gp-stop")}; sleep 600` } },
			{ text: "Never." },
		]);
		const pane = real.start(["--", "delegate"]);
		await waitFor(() => expect(recordOf(real, "gp").status).toBe("running"));
		const beats = join(worktreeOf(real, "gp"), "beats.jsonl");
		await waitFor(() => expect(readHeartbeats(beats).some((beat) => beat.ppid === 1)).toBe(true));

		real.tmux.sendKeys(pane, ["Escape"]);
		await waitFor(() => expect(recordOf(real, "gp").status).toBe("cancelled"));
		expect(await quietAfterBeats(beats)).toEqual({ started: true, quiet: true });
		// Its partial work stays: the worktree and what it wrote there.
		expect(existsSync(beats)).toBe(true);
	});

	it("ends what its command started when its host is killed mid-command, and says it failed", async () => {
		const real = await startOrchestrator();
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "general-purpose", name: "gp", task: "Run it.", background: true } },
			{ text: "waiting" },
			{ text: "seen" },
		]);
		real.script("gp", [
			{ tool: "bash", args: { command: `${escaping("beats.jsonl", "gp-owner")}; sleep 600` } },
			{ text: "Never." },
		]);
		real.start(["--", "delegate"]);
		await waitFor(() => expect(recordOf(real, "gp").status).toBe("running"));
		const beats = join(worktreeOf(real, "gp"), "beats.jsonl");
		await waitFor(() => expect(readHeartbeats(beats).some((beat) => beat.ppid === 1)).toBe(true));

		process.kill(readJson(join(runDir(real.agentDir, "gp"), "rpc-host.json")).hostPid, "SIGKILL");
		await waitFor(() => expect(recordOf(real, "gp").status).toBe("failed"));
		expect(recordOf(real, "gp").errorMessage).toMatch(/host ended before its pi did/);
		expect(await quietAfterBeats(beats)).toEqual({ started: true, quiet: true });
	});

	it("ends what its command started once its orchestrator crashed and its host and pi were killed, before its slot frees", async () => {
		const real = await startOrchestrator();
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "general-purpose", name: "gp", task: "Run it.", background: true } },
			{ text: "waiting" },
		]);
		real.script("gp", [
			{ tool: "bash", args: { command: `${escaping("beats.jsonl", "gp-lost")}; sleep 600` } },
			{ text: "Never." },
		]);
		const orchestrator = real.start(["--", "delegate"]);
		await waitFor(() => expect(recordOf(real, "gp").status).toBe("running"));
		const beats = join(worktreeOf(real, "gp"), "beats.jsonl");
		await waitFor(() => expect(readHeartbeats(beats).some((beat) => beat.ppid === 1)).toBe(true));

		// Nobody but the daemon is left to end them: the orchestrator crashed, the host's group was killed whole.
		crash(real, orchestrator);
		const { hostPid } = readJson(join(runDir(real.agentDir, "gp"), "rpc-host.json"));
		process.kill(-hostPid, "SIGKILL");
		await waitFor(() => Date.now() - statSync(beats).mtimeMs > 500);
		expect(await quietAfterBeats(beats)).toEqual({ started: true, quiet: true });
	});

	it("asks its orchestrator before a command reaches a host, and reaches none the user refuses", async () => {
		const real = await startOrchestrator();
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "general-purpose", name: "gp", task: "Fetch.", background: true } },
			{ text: "waiting" },
			{ text: "seen" },
		]);
		real.script("gp", [
			{ tool: "bash", args: { command: "curl -s -o /dev/null -w '%{http_code}' http://example.com/" } },
			{ text: "Could not fetch." },
		]);
		const orchestrator = real.start(["--", "delegate"]);
		const screen = () => unwrapped(real, orchestrator);
		await waitFor(() => expect(screen()).toContain(squeezed("network access to example.com:80")));
		const { runId } = recordOf(real, "gp");
		expect(screen()).toContain(squeezed(`Subagent "gp" (${runId}), generation 0, asks for approval`));
		real.tmux.sendKeys(orchestrator, ["Down", "Enter"]);
		const [, fetched] = await real.waitForRequests("gp", 2);
		expect(toolResults(fetched).at(-1)).not.toMatch(/^200/);
	});
});
