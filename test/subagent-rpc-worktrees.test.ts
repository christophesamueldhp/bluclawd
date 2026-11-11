import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	conversation,
	FAUX,
	type FauxRequest,
	hasTmux,
	type RealPi,
	startRealPi,
	systemPrompt,
	toolNames,
} from "./helpers/real-pi.ts";
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

/**
 * A repository with every kind of local state: committed, staged, unstaged, untracked, and ignored (a secret).
 */
function dirtyRepository(dir: string): void {
	write(dir, { ".gitignore": ".env\n", "a.txt": "one\n", "b.txt": "two\n", "pkg/p.txt": "pee\n" });
	git(dir, "init", "-q");
	git(dir, "add", ".");
	git(dir, "commit", "-q", "-m", "start");
	write(dir, { "b.txt": "two staged\n" });
	git(dir, "add", "b.txt");
	write(dir, { "a.txt": "one unstaged\n", "c.txt": "untracked\n", ".env": "SECRET\n" });
}

/** All of a checkout's state Git sees, ignored files and every ref included. */
function checkoutState(dir: string): string {
	return [
		git(dir, "status", "--porcelain=v1", "-uall", "--ignored"),
		git(dir, "diff", "--cached"),
		git(dir, "diff"),
		git(dir, "for-each-ref", "refs/heads", "refs/tags"),
		git(dir, "rev-parse", "HEAD"),
	].join("\n");
}

/** The isolated worktree a Report names. */
function workspaceOf(report: string | undefined): string {
	const match = /^Workspace: (.+?), an isolated Git worktree/m.exec(report ?? "");
	if (!match) throw new Error(`No workspace in the Report: ${report}`);
	return match[1];
}

/** Merges `added` into the settings every pi of the test reads; before a pane starts, it holds for that pane. */
function addSettings(real: RealPi, added: Record<string, unknown>): void {
	const path = join(real.agentDir, "settings.json");
	writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...added }));
}

/** The stored record of the run named `name`. */
function runRecord(agentDir: string, name: string): { runId: string; status: string; cwd: string } | undefined {
	const root = join(agentDir, "bluclawd", "subagents");
	for (const session of readdirSync(root)) {
		for (const run of readdirSync(join(root, session))) {
			const path = join(root, session, run, "record.json");
			const record = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
			if (record?.name === name) return record;
		}
	}
	return undefined;
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

describe.skipIf(!hasTmux)("an RPC run that edits", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	it("edits a worktree of its own, made from the checkout as it was at its Admission, and leaves the checkout alone", async () => {
		const real = await startOrchestrator();
		pi = real;
		const repo = real.cwd;
		dirtyRepository(repo);
		const before = checkoutState(repo);
		real.script("main", [
			{ tool: "subagent", args: { agent: writer, name: "w", cwd: "pkg", task: "Edit." } },
			{ text: "done" },
		]);
		real.script("w", [
			{ tool: "read", args: { path: "../c.txt" } },
			{ tool: "read", args: { path: "../.env" } },
			{ tool: "write", args: { path: "new.txt", content: "new\n" } },
			{ tool: "edit", args: { path: "../a.txt", edits: [{ oldText: "one unstaged", newText: "one edited" }] } },
			{ text: "Edited." },
		]);
		real.start(["--", "delegate"]);
		const main = await real.waitForRequests("main", 2);

		const w = real.requests("w");
		expect(w).toHaveLength(5);
		expect(systemPrompt(w[0])).toMatch(/You work in an isolated Git worktree, .*You have no shell/s);
		expect(lastToolResult(w[1])?.text).toBe("untracked\n");
		// Ignored, so not copied: a secret stays where it was.
		expect(lastToolResult(w[2])?.text).toMatch(/ENOENT|not found|No such file/i);
		expect(JSON.stringify(w)).not.toContain("SECRET");

		const report = lastToolResult(main[1])?.text;
		const workspace = workspaceOf(report);
		expect(report).toMatch(/^Baseline: [0-9a-f]{40} \(refs\/bluclawd\/runs\/sub_[^/]+\/baseline\)/m);
		expect(report).toMatch(/^Changes since its baseline: M a\.txt, A pkg\/new\.txt$/m);

		// The checkout is as it was: no edit, no new file, no commit, no branch.
		expect(checkoutState(repo)).toBe(before);
		expect(existsSync(join(repo, "pkg", "new.txt"))).toBe(false);
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one unstaged\n");

		// The worktree started as the checkout was, staged apart from unstaged, and holds the run's edits besides.
		expect(git(workspace, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "HEAD"));
		expect(git(workspace, "diff", "--cached")).toBe(git(repo, "diff", "--cached"));
		expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("one edited\n");
		expect(readFileSync(join(workspace, "c.txt"), "utf8")).toBe("untracked\n");
		expect(readFileSync(join(workspace, "pkg", "new.txt"), "utf8")).toBe("new\n");
		expect(existsSync(join(workspace, ".env"))).toBe(false);
		expect(JSON.stringify([...main, ...w])).not.toContain("ran dry");
	});

	it("changes nothing outside its worktree, through links, its .git, codemode or its checkout's deny rules", async () => {
		const real = await startOrchestrator();
		pi = real;
		const repo = real.cwd;
		const outside = join(repo, "..", "outside");
		mkdirSync(outside);
		write(repo, {
			"a.txt": "one\n",
			"pkg/secret.txt": "token SECRET-S\n",
			"pkg/ok.txt": "token FINE\n",
			"pkg/locked.txt": "locked\n",
		});
		// Committed links: out of the repository, back into the checkout, and to nothing.
		symlinkSync(outside, join(repo, "out"));
		symlinkSync(join(repo, "a.txt"), join(repo, "alias.txt"));
		symlinkSync(join(outside, "ghost.txt"), join(repo, "ghost.txt"));
		symlinkSync(".git", join(repo, "g"));
		git(repo, "init", "-q");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "start");
		// The orchestrator's rules name the checkout's files; its run's copies are held to them as well.
		addSettings(real, {
			defaultTools: ["+grep"],
			permissions: { deny: ["Read(pkg/secret.txt)", "Edit(pkg/locked.txt)"] },
		});
		const before = checkoutState(repo);
		real.script("main", [
			// Pointed at the checkout itself, it still works in its worktree.
			{
				tool: "subagent",
				args: {
					agent: { ...writer, tools: [...writer.tools, "grep", "codemode"] },
					name: "w",
					cwd: join(repo, "pkg"),
					task: "Escape.",
				},
			},
			{ text: "done" },
		]);
		const attempts: [string, Record<string, string>][] = [
			["write", { path: join(repo, "a.txt"), content: "x" }],
			["write", { path: "../../escaped.txt", content: "x" }],
			["write", { path: "../out/x.txt", content: "x" }],
			["edit", { path: "../alias.txt", oldText: "one", newText: "x" }],
			["write", { path: "../ghost.txt", content: "x" }],
			["write", { path: "../.git", content: "gitdir: /tmp\n" }],
			["write", { path: "../.GIT/config", content: "x" }],
			["write", { path: "../g", content: "gitdir: /tmp\n" }],
			["read", { path: "secret.txt" }],
			["edit", { path: "locked.txt", oldText: "locked", newText: "x" }],
		];
		const code = [
			"const out = [];",
			`for (const path of ${JSON.stringify([join(repo, "nested.txt"), "../out/nested.txt", "fine.txt"])}) {`,
			'  try { await tools.write({ path, content: "x" }); out.push(path + ": ran"); } catch (error) { out.push(path + ": " + error.message); }',
			"}",
			'out.push(await tools.grep({ pattern: "token", path: "." }));',
			'return out.join("\\n");',
		].join("\n");
		real.script("w", [
			...attempts.map(([tool, args]) => ({ tool, args })),
			{ tool: "grep", args: { pattern: "token", path: "." } },
			{ tool: "codemode", args: { code } },
			{ text: "Tried." },
		]);
		real.start(["--", "delegate"]);
		const main = await real.waitForRequests("main", 2);

		const w = real.requests("w");
		expect(w).toHaveLength(attempts.length + 3);
		for (let step = 1; step <= attempts.length; step++) {
			expect(lastToolResult(w[step])?.text).toMatch(/^(Refused|Blocked by permission rule)/);
		}
		// A folder grep finds the files it may read, in the worktree.
		expect(lastToolResult(w[attempts.length + 1])?.text).toContain("token FINE");
		const nested = lastToolResult(w[attempts.length + 2])?.text ?? "";
		expect(nested).toContain("token FINE");
		expect(nested).toMatch(/nested\.txt: Refused/);
		expect(nested).toMatch(/out\/nested\.txt: Refused/);
		expect(nested).toContain("fine.txt: ran");
		expect(JSON.stringify(w)).not.toContain("SECRET-S");

		// Nothing changed but the one file it was allowed, in its worktree.
		expect(checkoutState(repo)).toBe(before);
		expect(readdirSync(outside)).toEqual([]);
		expect(existsSync(join(repo, "..", "escaped.txt"))).toBe(false);
		expect(readdirSync(join(real.agentDir, "bluclawd", "worktrees"))).toHaveLength(1);
		const report = lastToolResult(main[1])?.text;
		expect(report).toMatch(/^Changes since its baseline: A pkg\/fine\.txt$/m);
		const workspace = workspaceOf(report);
		expect(git(workspace, "status", "--porcelain")).toBe("?? pkg/fine.txt\n");
		expect(readFileSync(join(workspace, "pkg", "locked.txt"), "utf8")).toBe("locked\n");
	});

	it("works beside other writers, each from the state its own Admission recorded, however long it waited", async () => {
		const real = await startOrchestrator();
		pi = real;
		addSettings(real, { subagents: { maxActive: 2 } });
		const repo = real.cwd;
		write(repo, { "a.txt": "one\n" });
		git(repo, "init", "-q");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "start");
		write(repo, { "a.txt": "one local\n" });
		const head = git(repo, "rev-parse", "HEAD");
		// Outside the repository: a gate is not part of anyone's state.
		const gate = join(repo, "..", "go");
		const names = ["w1", "w2", "w3"];
		real.script("main", [
			{
				calls: names.map((name) => ({
					tool: "subagent",
					args: { agent: writer, name, background: true, task: "Edit." },
				})),
			},
			...Array(4).fill({ text: "waiting" }),
		]);
		for (const name of names) {
			real.script(name, [
				{ tool: "edit", args: { path: "a.txt", edits: [{ oldText: "local", newText: `local ${name}` }] } },
				{ text: "Edited.", until: gate },
			]);
		}
		real.start(["--", "delegate"]);
		await real.waitForRequests("main", 2);
		// Two edit side by side, whichever the queue took first; the third waits for a slot, admitted already.
		const edited = () => names.filter((name) => real.requests(name).length === 2);
		await waitFor(() => expect(edited()).toHaveLength(2));
		expect(names.filter((name) => real.requests(name).length === 0)).toHaveLength(1);

		// The orchestrator's checkout moves on meanwhile: a new edit, a new commit.
		write(repo, { "a.txt": "one later\n", "later.txt": "later\n" });
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "later");
		writeFileSync(gate, "");
		await waitFor(() => {
			for (const name of names) expect(runRecord(real.agentDir, name)).toMatchObject({ status: "closed" });
		});

		const roots = new Set<string>();
		for (const name of names) {
			const { cwd } = runRecord(real.agentDir, name)!;
			roots.add(cwd);
			expect(git(cwd, "rev-parse", "HEAD")).toBe(head);
			expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe(`one local ${name}\n`);
			expect(existsSync(join(cwd, "later.txt"))).toBe(false);
		}
		expect(roots.size).toBe(3);
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one later\n");
	});

	it("refuses a writer it cannot isolate, while readers share a checkout, in Git or not, and see no writer's edits", async () => {
		const real = await startOrchestrator();
		pi = real;
		const plain = join(real.cwd, "plain");
		const empty = join(real.cwd, "empty");
		const repo = join(real.cwd, "repo");
		write(real.cwd, { "plain/p.txt": "plain\n", "repo/a.txt": "one\n" });
		mkdirSync(empty);
		git(empty, "init", "-q");
		git(repo, "init", "-q");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "start");
		const gate = join(real.cwd, "..", "go");
		const edited = join(real.cwd, "..", "edited");
		real.script("main", [
			{ tool: "subagent", args: { agent: writer, name: "nogit", cwd: plain, task: "Edit." } },
			{ tool: "subagent", args: { agent: writer, name: "unborn", cwd: empty, task: "Edit." } },
			{ tool: "subagent", args: { agent: "explorer", name: "look-plain", cwd: plain, task: "Read p.txt." } },
			{
				tool: "subagent",
				args: { agent: "general-purpose", name: "gp", cwd: repo, background: true, task: "Edit." },
			},
			{
				tool: "subagent",
				args: { agent: "explorer", name: "look-repo", cwd: repo, task: "Read a.txt." },
				until: edited,
			},
			{ text: "done", until: gate },
			{ text: "noted" },
		]);
		real.script("look-plain", [{ tool: "read", args: { path: "p.txt" } }, { text: "Read it." }]);
		real.script("gp", [
			{ tool: "edit", args: { path: "a.txt", edits: [{ oldText: "one", newText: "edited" }] } },
			{ text: "Edited.", until: gate },
		]);
		real.script("look-repo", [{ tool: "read", args: { path: "a.txt" } }, { text: "Read it." }]);
		real.start(["--", "delegate"]);
		// The reader in the repository starts once the writer has made its edit.
		await waitFor(() => expect(real.requests("gp")).toHaveLength(2));
		writeFileSync(edited, "");
		const main = await real.waitForRequests("main", 6);
		writeFileSync(gate, "");
		await real.waitForRequests("main", 7);

		for (const [step, dir] of [
			[1, plain],
			[2, empty],
		] as const) {
			const refusal = lastToolResult(main[step])?.text;
			expect(refusal).toMatch(/may edit files, so it works in an isolated Git worktree, and none can be made/);
			expect(refusal).toContain(
				step === 1 ? `${realpathSync(dir)} is not in a Git repository` : "has no commit yet",
			);
			expect(refusal).toContain("never works in a shared checkout");
		}
		expect(real.requests("nogit")).toHaveLength(0);
		expect(real.requests("unborn")).toHaveLength(0);
		// Readers work in the directory they were given, Git or not.
		expect(lastToolResult(real.requests("look-plain")[1])?.text).toBe("plain\n");
		expect(runRecord(real.agentDir, "look-plain")?.cwd).toBe(realpathSync(plain));
		expect(runRecord(real.agentDir, "look-repo")?.cwd).toBe(realpathSync(repo));
		expect(lastToolResult(real.requests("look-repo")[1])?.text).toBe("one\n");
		// The bundled implementer edits on pi's RPC, in a worktree of its own.
		expect(toolNames(real.requests("gp")[0]).sort()).toEqual([
			"codemode",
			"edit",
			"read",
			"subagent_message",
			"write",
		]);
		expect(runRecord(real.agentDir, "gp")?.cwd).not.toBe(realpathSync(repo));
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\n");
		expect(readdirSync(join(real.agentDir, "bluclawd", "worktrees"))).toHaveLength(1);
		expect(readdirSync(plain)).toEqual(["p.txt"]);
	});

	it("resumes in its own worktree, the changes of every generation in its Report", async () => {
		const real = await startOrchestrator();
		pi = real;
		const repo = real.cwd;
		write(repo, { "a.txt": "one\n" });
		git(repo, "init", "-q");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "start");
		real.script("main", [
			{ tool: "subagent", args: { agent: writer, name: "w", task: "Write one." } },
			{ tool: "subagent_resume", args: { agent: "w", task: "Write two." } },
			{ text: "waiting for w" },
			{ text: "noted" },
		]);
		real.script("w", [
			{ tool: "write", args: { path: "one.txt", content: "1\n" } },
			{ text: "Wrote one." },
			{ tool: "write", args: { path: "two.txt", content: "2\n" } },
			{ text: "Wrote two." },
		]);
		real.start(["--", "delegate"]);
		const main = await real.waitForRequests("main", 4);

		const first = lastToolResult(main[1])?.text;
		expect(first).toMatch(/^Changes since its baseline: A one\.txt$/m);
		const resumed = conversation(main[3]).at(-1)?.text;
		expect(resumed).toContain("Wrote two.");
		expect(resumed).toMatch(/^Changes since its baseline: A one\.txt, A two\.txt$/m);
		expect(workspaceOf(resumed)).toBe(workspaceOf(first));
		expect(readdirSync(repo).sort()).toEqual([".git", "a.txt"]);
	});
});
