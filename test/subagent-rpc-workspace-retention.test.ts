import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversation, FAUX, type FauxRequest, hasTmux, type RealPi, startRealPi } from "./helpers/real-pi.ts";
import { waitFor } from "./helpers/wait-for.ts";

/** The last tool result the model was given. */
const lastToolResult = (request: FauxRequest) =>
	conversation(request)
		.filter((message) => message.role === "toolResult")
		.at(-1);

/** Git in `cwd`, as a user of the fixture repository: its own identity, no hooks, no signing. */
function git(cwd: string, ...args: string[]): string {
	const result = spawnSync(
		"git",
		["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args],
		{ cwd, encoding: "utf8" },
	);
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
}

/** Writes `files` under `dir`, making their directories. */
function write(dir: string, files: Record<string, string>): void {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
}

/** A repository with committed, staged, unstaged, untracked and ignored state. */
function dirtyRepository(dir: string): void {
	write(dir, { ".gitignore": ".env\nbuild/\n", "a.txt": "one\n", "b.txt": "two\n" });
	git(dir, "init", "-q");
	git(dir, "add", ".");
	git(dir, "commit", "-q", "-m", "start");
	write(dir, { "b.txt": "two staged\n" });
	git(dir, "add", "b.txt");
	write(dir, { "a.txt": "one unstaged\n", "c.txt": "untracked\n", ".env": "SECRET\n" });
}

/** What runs left in the user's repository: bluclawd's private refs, and the worktrees Git knows besides the checkout. */
function leftInRepository(repo: string): { refs: string[]; worktrees: string[] } {
	const lines = (text: string) => text.split("\n").filter(Boolean);
	return {
		refs: lines(git(repo, "for-each-ref", "--format=%(refname)", "refs/bluclawd")),
		worktrees: lines(git(repo, "worktree", "list", "--porcelain"))
			.filter((line) => line.startsWith("worktree "))
			.slice(1)
			.map((line) => line.slice("worktree ".length)),
	};
}

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

/** The worktree a run's Admission recorded for it. */
const worktreeOf = (real: RealPi, name: string): string =>
	readJson(join(runDir(real.agentDir, name), "definition.json")).workspace.root;

/** Merges `added` into the settings every pi of the test reads, as they are read next. */
function addSettings(real: RealPi, added: Record<string, unknown>): void {
	const path = join(real.agentDir, "settings.json");
	writeFileSync(path, JSON.stringify({ ...readJson(path), ...added }));
}

/** An orchestrator pane whose runs are RPC children. */
async function startOrchestrator(): Promise<RealPi> {
	vi.stubEnv("BLUCLAWD_RPC_RUNS", "1");
	vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", FAUX);
	return startRealPi();
}

const writer = {
	name: "writer",
	description: "Edits files.",
	instructions: "You are the writer role: make the change asked.",
	tools: ["read", "edit", "write"],
};

const launch = (name: string, task = "Edit.") => ({
	tool: "subagent",
	args: { agent: writer, name, background: true, task },
});

describe.skipIf(!hasTmux)("the workspace of an RPC run that edits", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	it("leaves nothing in the repository when it never started", async () => {
		const real = await startOrchestrator();
		pi = real;
		addSettings(real, { subagents: { maxActive: 1 } });
		const repo = real.cwd;
		dirtyRepository(repo);
		const gate = join(real.cwd, "..", "first.go");
		real.script("main", [
			{ calls: [launch("first"), launch("queued")] },
			{ text: "waiting" },
			{ tool: "subagent_stop", args: { agent: "queued" } },
			{ text: "stopped it" },
			{ text: "read first's report" },
		]);
		real.script("first", [
			{ tool: "write", args: { path: "first.txt", content: "first\n" } },
			{ text: "First done.", until: gate },
		]);
		real.script("queued", [{ text: "Never." }]);
		const pane = real.start(["--", "delegate"]);
		await real.waitForRequests("first", 2);
		await real.waitForRequests("main", 2);
		const queued = worktreeOf(real, "queued");
		await waitFor(() => expect(leftInRepository(repo).worktrees).toHaveLength(2));

		real.tmux.sendKeys(pane, ["stop queued", "Enter"]);
		await real.waitForRequests("main", 4);
		expect(recordOf(real, "queued").status).toBe("cancelled");
		writeFileSync(gate, "");
		await real.waitForRequests("main", 5);

		expect(real.requests("queued")).toHaveLength(0);
		// Its worktree, Git's entry for it and its baseline's ref are gone; the run that worked keeps all of them.
		expect(existsSync(queued)).toBe(false);
		const first = worktreeOf(real, "first");
		expect(leftInRepository(repo)).toEqual({
			refs: [`refs/bluclawd/runs/${recordOf(real, "first").runId}/baseline`],
			worktrees: [first],
		});
		expect(readFileSync(join(first, "first.txt"), "utf8")).toBe("first\n");
	});

	it("keeps a workspace holding changes after it completed, failed or was stopped", async () => {
		const real = await startOrchestrator();
		pi = real;
		const repo = real.cwd;
		dirtyRepository(repo);
		const names = ["done", "broke", "halted", "built"];
		real.script("main", [
			{ calls: names.map((name) => launch(name)) },
			{ text: "waiting" },
			{ tool: "subagent_stop", args: { agent: "halted" } },
			...Array(6).fill({ text: "noted" }),
		]);
		const changed = (name: string) => ({ tool: "write", args: { path: `${name}.txt`, content: `${name}\n` } });
		real.script("done", [changed("done"), { text: "Done." }]);
		real.script("broke", [changed("broke"), { text: "", error: "provider down" }]);
		real.script("halted", [changed("halted"), { text: "Never.", until: join(real.cwd, "..", "never") }]);
		// Only a file Git ignores: Git sees no change, yet it is not in the baseline.
		real.script("built", [
			{ tool: "write", args: { path: "build/out.txt", content: "built\n" } },
			{ text: "Built." },
		]);
		const pane = real.start(["--", "delegate"]);
		await real.waitForRequests("halted", 2);
		await real.waitForRequests("main", 2);
		real.tmux.sendKeys(pane, ["stop halted", "Enter"]);
		await waitFor(() => {
			expect(recordOf(real, "done").status).toBe("closed");
			expect(recordOf(real, "broke").status).toBe("closed");
			expect(recordOf(real, "halted").status).toBe("cancelled");
			expect(recordOf(real, "built").status).toBe("closed");
		});

		for (const name of ["done", "broke", "halted"]) {
			expect(readFileSync(join(worktreeOf(real, name), `${name}.txt`), "utf8")).toBe(`${name}\n`);
		}
		expect(readFileSync(join(worktreeOf(real, "built"), "build", "out.txt"), "utf8")).toBe("built\n");
		expect(leftInRepository(repo).worktrees.sort()).toEqual(names.map((name) => worktreeOf(real, name)).sort());
		expect(leftInRepository(repo).refs).toHaveLength(4);
	});

	it("removes a workspace it left unchanged, and Resume makes it again exactly as admitted, not as the checkout is now", async () => {
		const real = await startOrchestrator();
		pi = real;
		const repo = real.cwd;
		dirtyRepository(repo);
		const head = git(repo, "rev-parse", "HEAD");
		const staged = git(repo, "diff", "--cached");
		real.script("main", [
			{ tool: "subagent", args: { agent: writer, name: "w", task: "Look." } },
			{ text: "looked" },
			{ tool: "subagent_resume", args: { agent: "w", task: "Now write." } },
			{ text: "waiting" },
			{ text: "noted" },
		]);
		real.script("w", [
			{ tool: "read", args: { path: "a.txt" } },
			{ text: "Looked." },
			{ tool: "read", args: { path: "a.txt" } },
			{ tool: "read", args: { path: "c.txt" } },
			{ tool: "write", args: { path: "new.txt", content: "new\n" } },
			{ text: "Wrote." },
		]);
		const pane = real.start(["--", "delegate"]);
		const main = await real.waitForRequests("main", 2);

		const root = worktreeOf(real, "w");
		const { runId } = recordOf(real, "w");
		const report = lastToolResult(main[1])?.text;
		expect(report).toContain(
			`Workspace: ${root}, removed: it held no change since its baseline, from which a Resume makes it again.`,
		);
		expect(report).toMatch(/^Changes since its baseline: none$/m);
		expect(existsSync(root)).toBe(false);
		expect(leftInRepository(repo)).toEqual({ refs: [`refs/bluclawd/runs/${runId}/baseline`], worktrees: [] });

		// The checkout moves on: a commit of everything, then a new local edit.
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "later");
		write(repo, { "a.txt": "one later\n" });
		real.tmux.sendKeys(pane, ["resume w", "Enter"]);
		const resumed = await real.waitForRequests("main", 5);

		const w = real.requests("w");
		expect(lastToolResult(w[3])?.text).toBe("one unstaged\n");
		expect(lastToolResult(w[4])?.text).toBe("untracked\n");
		expect(conversation(resumed[4]).at(-1)?.text).toMatch(/^Changes since its baseline: A new\.txt$/m);
		// Its worktree is back as its Admission recorded it: HEAD, staged apart from unstaged, untracked; no secret.
		expect(git(root, "rev-parse", "HEAD")).toBe(head);
		expect(git(root, "diff", "--cached")).toBe(staged);
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one unstaged\n");
		expect(git(root, "status", "--porcelain")).toBe(" M a.txt\nM  b.txt\n?? c.txt\n?? new.txt\n");
		expect(existsSync(join(root, ".env"))).toBe(false);
	});

	it("removes a workspace holding changes only at the user's request, after which Resume is refused and its evidence kept", async () => {
		const real = await startOrchestrator();
		pi = real;
		const repo = real.cwd;
		dirtyRepository(repo);
		const gate = join(real.cwd, "..", "w.go");
		real.script("main", [
			launch("w"),
			{ text: "waiting" },
			{ text: "noted" },
			{ tool: "subagent_resume", args: { agent: "w", task: "Go on." } },
			{ text: "it cannot resume" },
		]);
		real.script("w", [
			{ tool: "write", args: { path: "new.txt", content: "new\n" } },
			{ text: "Wrote.", until: gate },
			{ text: "Never." },
		]);
		const pane = real.start(["--", "delegate"]);
		await real.waitForRequests("w", 2);
		await real.waitForRequests("main", 2);
		const root = worktreeOf(real, "w");
		const screen = () => real.tmux.capture(pane, 80).join("\n").replace(/\s+/g, " ");

		// Not while it works.
		real.tmux.sendKeys(pane, ["/clean-workspace w", "Enter"]);
		await waitFor(() => expect(screen()).toMatch(/"w" \(sub_[\w-]+\) is still running: stop it, or let it finish/));
		expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("new\n");

		writeFileSync(gate, "");
		await real.waitForRequests("main", 3);
		const { runId, transcriptPath } = recordOf(real, "w");
		const dir = runDir(real.agentDir, "w");
		real.tmux.sendKeys(pane, ["/clean-workspace w", "Enter"]);
		await waitFor(() => expect(screen()).toContain('with its changes (A new.txt); "w"'));
		expect(screen()).toMatch(/can no longer be resumed\. Its transcript and Reports are kept\./);
		expect(existsSync(root)).toBe(false);
		expect(leftInRepository(repo)).toEqual({ refs: [], worktrees: [] });

		real.tmux.sendKeys(pane, ["resume w", "Enter"]);
		const main = await real.waitForRequests("main", 5);
		const refusal = lastToolResult(main[4])?.text;
		expect(refusal).toContain(
			`Cannot resume "w" (${runId}): its worktree ${root} was removed at the user's request, with its changes since its baseline (A new.txt), which cannot be made again. It resumes only in its own workspace, never in the checkout as it is now`,
		);
		expect(refusal).toContain(join(dir, "report.md"));
		expect(real.requests("w")).toHaveLength(2);
		expect(existsSync(root)).toBe(false);
		expect(readFileSync(transcriptPath, "utf8")).toContain("Wrote.");
		expect(readFileSync(join(dir, "reports", "1.md"), "utf8")).toContain("Wrote.");
		expect(existsSync(join(repo, "new.txt"))).toBe(false);
	});
});
