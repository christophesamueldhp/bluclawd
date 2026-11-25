import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
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
import { runDirOf, runNamed, storedHost } from "./helpers/run-files.ts";
import { piStartsTimeout } from "./helpers/run-timing.ts";
import { waitFor } from "./helpers/wait-for.ts";

const contained = process.platform === "darwin" || process.platform === "linux";

const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

const recordOf = (real: RealPi, name: string) => runNamed(real.agentDir, name).record;
const worktreeOf = (real: RealPi, name: string) =>
	join(realpathSync(real.agentDir), "bluclawd", "worktrees", recordOf(real, name).runId);

const toolResults = (request: FauxRequest) =>
	conversation(request)
		.filter((message) => message.role === "toolResult")
		.map((message) => message.text);

const unwrapped = (real: RealPi, pane: string) => real.tmux.capture(pane, 80).join("").replace(/\s+/g, "");
const squeezed = (text: string) => text.replace(/\s+/g, "");

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync(
		"git",
		["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args],
		{ cwd, encoding: "utf8" },
	);
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
}

async function quietAfterBeats(path: string): Promise<{ started: boolean; quiet: boolean }> {
	const before = readHeartbeats(path).length;
	await new Promise((resolve) => setTimeout(resolve, 300));
	return { started: before > 0, quiet: readHeartbeats(path).length === before };
}

async function startOrchestrator(): Promise<RealPi> {
	vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", FAUX);
	const real = await startRealPi();
	writeFileSync(join(real.cwd, "a.txt"), "one\n");
	git(real.cwd, "init", "-q");
	git(real.cwd, "add", ".");
	git(real.cwd, "commit", "-q", "-m", "start");
	return real;
}

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
		expect(toolNames(gp[0])).toEqual(expect.arrayContaining(["bash", "edit", "write", "read"]));
		const [made, escaped, daemon, , tested] = toolResults(gp[5]);
		expect(made).toBe("one\n[||]");
		expect(escaped).toMatch(/Operation not permitted|Read-only file system/);
		expect(existsSync(join(checkout, "escaped.txt"))).toBe(false);
		await expect(real.rows()).resolves.toBeDefined();
		expect(daemon).not.toContain("CONNECTED");

		expect(tested).toMatch(/pass 1\n/);
		expect(tested).toMatch(/\?\? made\.txt/);
		const report = toolResults(main[1]).at(-1);
		expect(report).toMatch(/Changes since its baseline: .*A made\.txt/);
		expect(git(checkout, "status", "--porcelain")).toBe("");
		expect(await quietAfterBeats(join(worktreeOf(real, "gp"), "beats.jsonl"))).toEqual({
			started: true,
			quiet: true,
		});
	});

	it("takes turns between its commands and its file tools, which a link its command made does not lead out of its worktree", async () => {
		const real = await startOrchestrator();
		pi = real;
		const checkout = realpathSync(real.cwd);
		writeFileSync(join(checkout, "secret.txt"), "TRACKED-SECRET\n");
		git(checkout, "add", "secret.txt");
		git(checkout, "commit", "-q", "-m", "secret");
		const settings = join(real.agentDir, "settings.json");
		writeFileSync(settings, JSON.stringify({ ...readJson(settings), permissions: { deny: ["Read(secret.txt)"] } }));
		real.script("main", [
			{ tool: "subagent", args: { agent: "general-purpose", name: "gp", task: "Mix them." } },
			{ text: "done" },
		]);
		real.script("gp", [
			{ tool: "bash", args: { command: `ln -s ${quote(checkout)} out` } },
			{ tool: "write", args: { path: "out/x.txt", content: "escaped\n" } },
			{ tool: "read", args: { path: "secret.txt" } },
			{ tool: "write", args: { path: "ok.txt", content: "fine\n" } },
			{ tool: "bash", args: { command: "cat ok.txt" } },
			{ tool: "read", args: { path: "ok.txt" } },
			{ text: "Mixed." },
		]);
		real.start(["--", "delegate"]);
		await real.waitForRequests("main", 2);

		const gp = real.requests("gp");
		expect(gp).toHaveLength(7);
		const [linked, escaped, secret, wrote, catted, read] = toolResults(gp[6]);
		expect(linked).toBe("(no output)");
		expect(escaped).toMatch(/outside this run's worktree/);
		expect(existsSync(join(checkout, "x.txt"))).toBe(false);
		expect(secret).toMatch(/Blocked by permission rule \(deny\): Read\(secret\.txt\)/);
		expect(wrote).toMatch(/Successfully wrote/);
		expect(catted).toBe("fine\n");
		expect(read).toBe("fine\n");
		expect(JSON.stringify(gp)).not.toContain("TRACKED-SECRET");
	});

	it(
		"runs commands after pi's shellCommandPrefix, as pi's bash does, and holds them to deny rules as the model wrote them",
		{ timeout: piStartsTimeout(2) },
		async () => {
			const real = await startOrchestrator();
			pi = real;
			const gate = join(real.cwd, "..", "prefixed");
			real.script("main", [
				{ tool: "subagent", args: { agent: "general-purpose", name: "gp1", task: "Echo." } },
				{ tool: "subagent", args: { agent: "general-purpose", name: "gp2", task: "Echo." }, until: gate },
				{ text: "done" },
			]);
			real.script("gp1", [{ tool: "bash", args: { command: 'echo "[$PFX]"' } }, { text: "Echoed." }]);
			real.script("gp2", [
				{ tool: "bash", args: { command: 'echo "[$PFX]"' } },
				{ tool: "bash", args: { command: "export Y=1" } },
				{ text: "Echoed." },
			]);
			real.start(["--", "delegate"]);
			await real.waitForRequests("main", 2);
			const settings = join(real.agentDir, "settings.json");
			writeFileSync(
				settings,
				JSON.stringify({
					...readJson(settings),
					shellCommandPrefix: "export PFX=applied",
					permissions: { deny: ["Bash(export *)"] },
				}),
			);
			writeFileSync(gate, "");
			await real.waitForRequests("main", 3);

			expect(toolResults(real.requests("gp1")[1])).toEqual(["[]\n"]);
			const [prefixed, denied] = toolResults(real.requests("gp2")[2]);
			expect(prefixed).toBe("[applied]\n");
			expect(denied).toMatch(/Blocked by permission rule \(deny\): Bash\(export \*\)/);
		},
	);

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

		process.kill(storedHost(runDirOf(real.agentDir, "gp")).hostPid, "SIGKILL");
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

		crash(real, orchestrator);
		const { hostPid } = storedHost(runDirOf(real.agentDir, "gp"));
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
