import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMarker } from "../daemon/run-members.ts";
import { endRunProcesses, prepareRunContainment } from "../ext/sandbox/run-containment.ts";
import { createRunShell, type RunShellScope, runShellTmp } from "../ext/subagents/run-shell.ts";
import { captureRunBaseline, materializeWorktree, worktreePath } from "../ext/subagents/run-worktree.ts";
import { descendantCommand, leavingBehind, readHeartbeats, readinessMs } from "./helpers/heartbeats.ts";
import { waitFor } from "./helpers/wait-for.ts";

const supported =
	process.platform === "darwin" &&
	SandboxManager.isSupportedPlatform() &&
	SandboxManager.checkDependencies().errors.length === 0;

const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

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

describe("a run's shell where it cannot be contained", () => {
	it("is refused off macOS, saying so", async () => {
		expect(await prepareRunContainment("linux")).toEqual({
			ok: false,
			reason: expect.stringMatching(/only on macOS so far, not on linux/),
		});
	});
});

describe.skipIf(!supported)("a run's shell, on the operating system", () => {
	let root: string;
	let source: string;
	let sibling: string;
	let agentDir: string;
	let runDir: string;
	let scope: RunShellScope;
	let worktree: string;
	let sockets: Server[] = [];
	const asked: { host: string; port: number | undefined }[] = [];
	let shell: ReturnType<typeof createRunShell>;

	/** Runs `command` in the run's shell from its worktree: its exit code and output. */
	async function run(command: string, signal?: AbortSignal): Promise<{ code: number | null; output: string }> {
		let output = "";
		const { exitCode } = await shell.exec(command, worktree, {
			onData: (data) => {
				output += data.toString();
			},
			signal,
			timeout: (2 * readinessMs) / 1000,
		});
		return { code: exitCode, output };
	}

	beforeAll(async () => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "bluclawd-run-shell-")));
		source = join(root, "source");
		sibling = join(root, "sibling");
		agentDir = join(root, "agent");
		const runId = `sub_${randomUUID()}`;
		runDir = join(agentDir, "bluclawd", "subagents", "session", runId);
		for (const dir of [source, sibling, join(runDir, "approvals", "0")]) mkdirSync(dir, { recursive: true });
		writeFileSync(join(runDir, "definition.json"), "{}\n");
		writeFileSync(join(agentDir, "auth.json"), "AGENT-CREDENTIAL\n");
		writeFileSync(join(sibling, "s.txt"), "SIBLING-SECRET\n");
		writeFileSync(join(source, "a.txt"), "one\n");
		writeFileSync(join(source, "secret.txt"), "TRACKED-SECRET\n");
		writeFileSync(join(source, "locked.txt"), "locked\n");
		mkdirSync(join(source, "keys"));
		writeFileSync(join(source, "keys", "k.pem"), "PEM-SECRET\n");
		writeFileSync(join(source, "keys", "id.txt"), "ID-SECRET\n");
		git(source, "init", "-q");
		git(source, "add", ".");
		git(source, "commit", "-q", "-m", "start");
		const captured = captureRunBaseline(source, runId);
		if (!captured.ok) throw new Error(captured.error);
		worktree = worktreePath(agentDir, runId);
		await materializeWorktree({ root: worktree, baseline: captured.baseline });
		scope = {
			runId,
			runDir,
			workspace: { root: worktree, source: captured.baseline.source, gitDir: captured.baseline.gitDir },
			deny: [
				{ cwd: source, rules: ["Read(secret.txt)", "Read(**/*.pem)", "Read(keys/id.txt)", "Edit(locked.txt)"] },
			],
		};
		// A private daemon's socket and a tmux server's, listening: outside the sandbox, both answer.
		for (const name of ["daemon.sock", "tmux.sock"]) {
			const server = createServer((socket) => socket.end("hello\n"));
			await new Promise<void>((resolve) => server.listen(join(root, name), resolve));
			sockets.push(server);
		}
		shell = createRunShell(scope, {
			agentDir,
			user: () => ({
				kind: "on",
				settings: {
					allowedDomains: [],
					allowWrite: [sibling],
					denyRead: [join(sibling, "s.txt")],
					denyWrite: [],
					denyUnixSockets: [],
					credentialFiles: [],
					written: { credentials: { envVars: [{ name: "RUN_SHELL_TOKEN", mode: "deny" }] } },
				},
			}),
			ask: async (request) => {
				asked.push(request);
				return false;
			},
		});
	}, 4 * readinessMs);

	afterAll(async () => {
		for (const server of sockets) server.close();
		sockets = [];
		await SandboxManager.reset();
		rmSync(runShellTmp(agentDir, scope.runId), { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	});

	it("runs a command in the worktree, writing there and in its own temp directory", async () => {
		const result = await run('printf made > made.txt && printf temp > "$TMPDIR/t.txt" && cat a.txt');
		expect(result).toMatchObject({ code: 0, output: "one\n" });
		expect(readFileSync(join(worktree, "made.txt"), "utf8")).toBe("made");
		expect(readFileSync(join(runShellTmp(agentDir, scope.runId), "t.txt"), "utf8")).toBe("temp");
	});

	it("writes nothing outside its worktree: the checkout, a sibling, through a link, or a temp directory others share", async () => {
		const escapes = [
			`printf x > ${quote(join(source, "escaped.txt"))}`,
			`printf x > ${quote(join(source, "a.txt"))}`,
			`printf x > ${quote(join(sibling, "escaped.txt"))}`,
			`ln -s ${quote(source)} out && printf x > out/linked.txt`,
			"mkdir -p /tmp/claude && printf x > /tmp/claude/escaped-run-shell.txt",
			"printf x > locked.txt",
		];
		for (const command of escapes) expect((await run(command)).code, command).not.toBe(0);
		expect(existsSync(join(source, "escaped.txt"))).toBe(false);
		expect(readFileSync(join(source, "a.txt"), "utf8")).toBe("one\n");
		expect(existsSync(join(sibling, "escaped.txt"))).toBe(false);
		expect(existsSync(join(source, "linked.txt"))).toBe(false);
		expect(existsSync("/tmp/claude/escaped-run-shell.txt")).toBe(false);
		expect(readFileSync(join(worktree, "locked.txt"), "utf8")).toBe("locked\n");
	});

	it("changes no Git state: neither its worktree's .git nor the Git directory it shares", async () => {
		const gitFile = readFileSync(join(worktree, ".git"), "utf8");
		const refs = git(source, "for-each-ref");
		for (const command of [
			"git update-ref refs/heads/escaped HEAD",
			"git add a.txt && git commit -qm escaped",
			`printf x > ${quote(join(scope.workspace.gitDir, "escaped"))}`,
			"printf 'gitdir: /tmp' > .git",
		]) {
			expect((await run(command)).code, command).not.toBe(0);
		}
		expect(readFileSync(join(worktree, ".git"), "utf8")).toBe(gitFile);
		expect(git(source, "for-each-ref")).toBe(refs);
		expect(existsSync(join(scope.workspace.gitDir, "escaped"))).toBe(false);
		// Reading it is how Git works in the worktree.
		expect(await run("git log --format=%s")).toMatchObject({ code: 0, output: "start\n" });
	});

	it("cannot approve itself or write its run's state: approvals, inbox and definition stay as they were", async () => {
		for (const command of [
			`printf allow > ${quote(join(runDir, "approvals", "0", "x.answer"))}`,
			`mkdir ${quote(join(runDir, "inbox"))}`,
			`printf '{}' > ${quote(join(runDir, "definition.json"))}`,
		]) {
			expect((await run(command)).code, command).not.toBe(0);
		}
		expect(existsSync(join(runDir, "approvals", "0", "x.answer"))).toBe(false);
		expect(existsSync(join(runDir, "inbox"))).toBe(false);
		expect(readFileSync(join(runDir, "definition.json"), "utf8")).toBe("{}\n");
	});

	it("reads no denied file, in the checkout or its copy in the worktree, nor the pi config directory", async () => {
		for (const command of [
			"cat secret.txt",
			`cat ${quote(join(source, "secret.txt"))}`,
			"ln -s secret.txt alias.txt && cat alias.txt",
			`cat ${quote(join(agentDir, "auth.json"))}`,
			`ls ${quote(runDir)}`,
			`cat ${quote(join(sibling, "s.txt"))}`,
		]) {
			const result = await run(command);
			expect(result.code, command).not.toBe(0);
			expect(result.output).not.toMatch(/TRACKED-SECRET|AGENT-CREDENTIAL|SIBLING-SECRET/);
		}
	});

	it("reads no denied file once renamed, hard-linked or moved with its directory, nor one a glob rule denies", async () => {
		const tried: Record<string, string> = {};
		for (const command of [
			"cat keys/k.pem",
			"mv secret.txt moved.txt; cat moved.txt",
			"ln secret.txt hard.txt; cat hard.txt",
			"cp secret.txt copy.txt; cat copy.txt",
			"mv keys keys2; cat keys2/k.pem keys2/id.txt",
			"cp -R keys keys3; cat keys3/id.txt",
			"ln -s secret.txt soft.txt; cat soft.txt",
		]) {
			tried[command] = (await run(command)).output;
		}
		expect(Object.values(tried).join("\n")).not.toMatch(/TRACKED-SECRET|PEM-SECRET|ID-SECRET/);
		// Not one of them got a name the rules do not cover: renaming or linking a denied file is refused too.
		for (const name of ["moved.txt", "hard.txt", "copy.txt", "keys2", "keys3/id.txt"]) {
			expect(existsSync(join(worktree, name)), name).toBe(false);
		}
		expect(readFileSync(join(source, "keys", "id.txt"), "utf8")).toBe("ID-SECRET\n");
	});

	it("keeps its worktree's .git link where it is", async () => {
		const gitFile = readFileSync(join(worktree, ".git"), "utf8");
		for (const command of ["rm -f .git", "mv .git moved-git"]) expect((await run(command)).code, command).not.toBe(0);
		expect(readFileSync(join(worktree, ".git"), "utf8")).toBe(gitFile);
	});

	it("cannot put a process under a profile of its own, out of its run's reach", async () => {
		const result = await run("sandbox-exec -p '(version 1)(allow default)' /bin/echo ESCAPED");
		expect(result.code).not.toBe(0);
		expect(result.output).toContain("sandbox_apply: Operation not permitted");
		expect(result.output).not.toContain("ESCAPED");
	});

	it("sees none of the variables the user's sandbox hides", async () => {
		process.env.RUN_SHELL_TOKEN = "hidden-value";
		try {
			expect((await run('printf "[%s]" "$RUN_SHELL_TOKEN"')).output).toBe("[]");
		} finally {
			delete process.env.RUN_SHELL_TOKEN;
		}
	});

	it("reaches neither a daemon's nor tmux's socket, by path", async () => {
		const connect = (path: string) =>
			`${quote(process.execPath)} -e ${quote(`require("net").connect(${JSON.stringify(path)}).on("data", (d) => { process.stdout.write("CONNECTED " + d); process.exit(0); }).on("error", (e) => { process.stdout.write(e.code); process.exit(1); })`)}`;
		// The same command outside the sandbox connects: the socket is real and listening.
		const outside = await new Promise<string>((resolve) =>
			execFile("/bin/bash", ["-c", connect(join(root, "daemon.sock"))], { encoding: "utf8" }, (_error, stdout) =>
				resolve(stdout),
			),
		);
		expect(outside).toBe("CONNECTED hello\n");
		for (const name of ["daemon.sock", "tmux.sock"]) {
			const result = await run(connect(join(root, name)));
			expect(result.code, name).not.toBe(0);
			expect(result.output).not.toContain("CONNECTED");
		}
	});

	it("asks before reaching a host, and reaches none it is refused", async () => {
		const result = await run("curl -s -o /dev/null -w '%{http_code}' http://example.com/");
		expect(result.output).not.toBe("200");
		expect(asked).toContainEqual(expect.objectContaining({ host: "example.com", port: 80 }));
	});

	it.each(["attached", "inherited-stdio", "detached", "double-fork"])(
		"ends a %s descendant with its command, even one that scrubs its environment",
		async (mode) => {
			const path = join(worktree, `beats-${mode}.jsonl`);
			const descendant = `env -i PATH=/usr/bin:/bin ${descendantCommand(mode, path, `id-${mode}`, 4 * readinessMs)}`;
			await run(leavingBehind(descendant, path));
			const after = await quietAfterBeats(path);
			expect(after).toEqual({ started: true, quiet: true });
		},
		4 * readinessMs,
	);

	it("ends a process that forks anew and exits every few milliseconds", async () => {
		const path = join(worktree, "hops.txt");
		const hopping = `env -i /bin/sh -c ${quote(`i=0; hop() { i=$((i+1)); echo $i >> ${quote(path)}; [ $i -lt 5000 ] && { (sleep 0.005; hop) & }; }; hop; sleep 0.5`)}`;
		await run(hopping);
		const count = () => readFileSync(path, "utf8").split("\n").filter(Boolean).length;
		const before = count();
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(before).toBeGreaterThan(5);
		expect(count()).toBe(before);
	});

	it("ends what a command started when its call is cancelled", async () => {
		const path = join(worktree, "beats-cancelled.jsonl");
		const stop = new AbortController();
		const running = run(
			`${descendantCommand("double-fork", path, "id-cancelled", 4 * readinessMs)}; sleep 600`,
			stop.signal,
		);
		await waitFor(() => readHeartbeats(path).some((beat) => beat.ppid === 1));
		stop.abort();
		await running.catch(() => undefined);
		expect(await quietAfterBeats(path)).toEqual({ started: true, quiet: true });
	});

	it("is ended from outside while a command still runs, as when the run's owner is gone", async () => {
		const path = join(worktree, "beats-owner.jsonl");
		const running = run(`${descendantCommand("double-fork", path, "id-owner", 4 * readinessMs)}; sleep 600`);
		await waitFor(() => readHeartbeats(path).some((beat) => beat.ppid === 1));
		const containment = await prepareRunContainment();
		if (!containment.ok) throw new Error(containment.reason);
		expect(await endRunProcesses({ helper: containment.helper, marker: runMarker(scope.runId) })).toBe(true);
		const result = await running.catch((error: Error) => ({ code: null, output: error.message }));
		expect(result.code).not.toBe(0);
		expect(await quietAfterBeats(path)).toEqual({ started: true, quiet: true });
	});
});
