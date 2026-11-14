import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { readinessMs } from "./helpers/heartbeats.ts";
import { conversation, FAUX, type FauxRequest, hasTmux, type RealPi, startRealPi } from "./helpers/real-pi.ts";
import { findRun, reportSeqs } from "./helpers/run-files.ts";
import { waitFor } from "./helpers/wait-for.ts";

/** The text of every tool result the model was given, in order. */
const toolResults = (request: FauxRequest) =>
	conversation(request)
		.filter((message) => message.role === "toolResult")
		.map((message) => message.text);

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

const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");

/** What Integration must never change: the index, HEAD, branches, tags and stash. */
function gitState(dir: string): string {
	return [
		git(dir, "diff", "--cached"),
		git(dir, "rev-parse", "HEAD"),
		git(dir, "for-each-ref", "refs/heads", "refs/tags", "refs/stash"),
	].join("\n");
}

/** A committed repository of `files`. */
function repository(dir: string, files: Record<string, string>): void {
	write(dir, files);
	git(dir, "init", "-q");
	git(dir, "add", ".");
	git(dir, "commit", "-q", "-m", "start");
}

const SEVEN = "1\n2\n3\n4\n5\n6\n7\n";

const writer = {
	name: "writer",
	description: "Edits files.",
	instructions: "You are the writer role: make the change asked.",
	tools: ["read", "edit", "write"],
};

/** A run's pi that leaves a process behind in its process group, which ignores SIGTERM. */
const LINGERER = fileURLToPath(new URL("./fixtures/real-pi/lingerer.ts", import.meta.url));

/** An orchestrator pane whose runs are RPC children, which load the faux provider, and `extensions`, as the pane does. */
async function startOrchestrator(extensions: string[] = []): Promise<RealPi> {
	vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", [FAUX, ...extensions].join(":"));
	return startRealPi();
}

/** The directory and stored record of the run named `name`. */
function runOf(real: RealPi, name: string): { dir: string; status: string } | undefined {
	const run = findRun(real.agentDir, name);
	return run && { dir: run.runDir, status: run.record.status };
}

/** The chain IDs the orchestrator's tool results name, in order. */
const chainIds = (request: FauxRequest) =>
	toolResults(request).flatMap((text) => /^Chain (chain_\w+):/m.exec(text)?.[1] ?? []);

describe.skipIf(!hasTmux)("integrating an RPC run's changes", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	it("applies only the run's changes onto the checkout as it is now, keeps every edit made meanwhile, and runs the check given", async () => {
		const real = await startOrchestrator();
		pi = real;
		const repo = real.cwd;
		repository(repo, { "a.txt": SEVEN, "b.txt": "bee\n", "c.txt": "cee\n" });
		// Local changes at the run's Admission: in its baseline, so never the run's own work.
		write(repo, { "b.txt": "bee local\n", "u.txt": "untracked\n" });
		const gate = join(repo, "..", "edited");
		const check = "grep -q '^2 parent$' a.txt && grep -q '^6 child$' a.txt && test -f d.txt";
		real.script("main", [
			{ tool: "subagent", args: { agent: writer, name: "w", task: "Edit." } },
			{ tool: "subagent_integrate", args: { agent: "w", preview: true } },
			{ tool: "subagent_integrate", args: { agent: "w", check } },
			{ tool: "subagent_integrate", args: { agent: "w" } },
			{ text: "done" },
		]);
		real.script("w", [
			{ tool: "edit", args: { path: "a.txt", edits: [{ oldText: "6\n", newText: "6 child\n" }] }, until: gate },
			{ tool: "edit", args: { path: "c.txt", edits: [{ oldText: "cee", newText: "cee child" }] } },
			{ tool: "write", args: { path: "n.txt", content: "new\n" } },
			{ text: "Edited; every test passes." },
		]);
		real.start(["--", "delegate"]);
		await waitFor(() => expect(real.requests("w").length).toBeGreaterThan(0));
		// Meanwhile the user edits the checkout: another line of a file the run edits, a new file, and a baseline
		// change taken back.
		write(repo, { "a.txt": SEVEN.replace("2\n", "2 parent\n"), "d.txt": "dee\n", "b.txt": "bee\n" });
		const before = gitState(repo);
		writeFileSync(gate, "");

		const main = await real.waitForRequests("main", 5);
		const [, preview, applied, again] = toolResults(main[4]);

		// The preview shows the run's own delta, apart from what the checkout had at its Admission, and writes nothing.
		expect(preview).toMatch(/^Changes of the run since its baseline: M a\.txt, M c\.txt, A n\.txt$/m);
		expect(preview).toContain("+6 child");
		expect(preview).not.toMatch(/b\.txt|u\.txt|bee local/);
		expect(preview).toMatch(/^Your checkout changed since its baseline in: M a\.txt$/m);

		expect(applied).toMatch(/^Integration: applied M a\.txt, M c\.txt, A n\.txt to /m);
		expect(applied).toMatch(/^Merged with your changes since its baseline: a\.txt$/m);
		expect(applied).toMatch(/^Run: completed/m);
		expect(applied).toContain(`Validation: \`${check}\` exited with code 0`);
		expect(again).toMatch(/^Nothing to integrate: .* already integrated/m);

		// Both sides' edits are there, the baseline change stays taken back, and nothing else changed.
		expect(read(repo, "a.txt")).toBe(SEVEN.replace("2\n", "2 parent\n").replace("6\n", "6 child\n"));
		expect(read(repo, "b.txt")).toBe("bee\n");
		expect(read(repo, "c.txt")).toBe("cee child\n");
		expect(read(repo, "d.txt")).toBe("dee\n");
		expect(read(repo, "n.txt")).toBe("new\n");
		expect(read(repo, "u.txt")).toBe("untracked\n");
		expect(gitState(repo)).toBe(before);
		const worktree = /^Its worktree (.+) is kept\.$/m.exec(applied)?.[1];
		expect(worktree && read(worktree, "n.txt")).toBe("new\n");
	});

	it("integrates two runs side by side one after the other, and reports a check the combined result fails apart from their outcomes", async () => {
		const real = await startOrchestrator();
		pi = real;
		const repo = real.cwd;
		repository(repo, { "a.txt": SEVEN });
		// Each run alone keeps it; the two together break it.
		const check = 'test "$(grep -c edited a.txt)" -lt 2';
		real.script("main", [
			{
				tool: "subagent",
				args: {
					tasks: [
						{ agent: writer, name: "left", task: "Edit line 2." },
						{ agent: writer, name: "right", task: "Edit line 6." },
					],
				},
			},
			{
				calls: [
					{ tool: "subagent_integrate", args: { agent: "left", check } },
					{ tool: "subagent_integrate", args: { agent: "right", check } },
				],
			},
			{ text: "done" },
		]);
		real.script("left", [
			{ tool: "edit", args: { path: "a.txt", edits: [{ oldText: "2\n", newText: "2 edited\n" }] } },
			{ text: "Done; the check passes." },
		]);
		real.script("right", [
			{ tool: "edit", args: { path: "a.txt", edits: [{ oldText: "6\n", newText: "6 edited\n" }] } },
			{ text: "Done; the check passes." },
		]);
		real.start(["--", "delegate"]);
		await waitFor(() => expect(real.requests("left").length).toBeGreaterThan(0));
		await waitFor(() => expect(real.requests("right").length).toBeGreaterThan(0));

		const main = await real.waitForRequests("main", 3);
		const results = toolResults(main[2]).slice(1);
		expect(results).toHaveLength(2);
		for (const text of results) {
			expect(text).toMatch(/^Integration: applied M a\.txt to /m);
			expect(text).toMatch(/^Run: completed/m);
		}
		// Whichever went second found the first one's edit in the checkout, merged with it, and failed the check.
		const passed = results.filter((text) => text.includes(`\`${check}\` exited with code 0`));
		const failed = results.filter((text) => text.includes(`\`${check}\` exited with code 1`));
		expect([passed.length, failed.length]).toEqual([1, 1]);
		expect(failed[0]).toMatch(/^Merged with your changes since its baseline: a\.txt$/m);
		expect(failed[0]).toContain("the combined result fails it. The applied changes stay");
		expect(read(repo, "a.txt")).toBe(SEVEN.replace("2\n", "2 edited\n").replace("6\n", "6 edited\n"));
	});

	it("applies nothing when a change conflicts, and applies the rest once the orchestrator resolved it in its checkout", async () => {
		const real = await startOrchestrator();
		pi = real;
		const repo = real.cwd;
		repository(repo, { "a.txt": SEVEN });
		const gate = join(repo, "..", "edited");
		const looked = join(repo, "..", "looked");
		const resolved = SEVEN.replace("4\n", "4 user and run\n");
		real.script("main", [
			{ tool: "subagent", args: { agent: writer, name: "w", task: "Edit." } },
			{ tool: "subagent_integrate", args: { agent: "w" } },
			{ tool: "write", args: { path: "a.txt", content: resolved }, until: looked },
			{ tool: "subagent_integrate", args: { agent: "w", keep: ["a.txt"] } },
			{ text: "done" },
		]);
		real.script("w", [
			{ tool: "edit", args: { path: "a.txt", edits: [{ oldText: "4\n", newText: "4 run\n" }] }, until: gate },
			{ tool: "write", args: { path: "n.txt", content: "new\n" } },
			{ text: "Edited." },
		]);
		real.start(["--", "delegate"]);
		await waitFor(() => expect(real.requests("w").length).toBeGreaterThan(0));
		write(repo, { "a.txt": SEVEN.replace("4\n", "4 user\n") });
		const before = gitState(repo);
		writeFileSync(gate, "");

		const main = await real.waitForRequests("main", 3);
		const refused = toolResults(main[2])[1];
		expect(refused).toMatch(/^Not integrated: nothing of .* was applied, and your checkout .* is as it was\.$/m);
		expect(refused).toMatch(/^- a\.txt: .*CONFLICT|^- a\.txt: .*conflict/im);
		expect(refused).toContain("ask them, and do not choose");
		// The user's edit is untouched, and nothing else of the run came in either.
		expect(read(repo, "a.txt")).toBe(SEVEN.replace("4\n", "4 user\n"));
		expect(existsSync(join(repo, "n.txt"))).toBe(false);
		writeFileSync(looked, "");

		const done = await real.waitForRequests("main", 5);
		const applied = toolResults(done[4])[3];
		expect(applied).toMatch(/^Integration: applied A n\.txt to /m);
		expect(applied).toMatch(/^Kept as in your checkout: a\.txt$/m);
		expect(read(repo, "a.txt")).toBe(resolved);
		expect(read(repo, "n.txt")).toBe("new\n");
		expect(gitState(repo)).toBe(before);
	});

	it("refuses a run that reported while its processes still run, one stopping, and one stopped, then takes the first once it settled", async () => {
		const real = await startOrchestrator([LINGERER]);
		pi = real;
		const repo = real.cwd;
		repository(repo, { ".gitignore": "lingerer.pid\n", "a.txt": SEVEN });
		const reported = join(repo, "..", "reported");
		const settled = join(repo, "..", "settled");
		const launch = (name: string) => ({
			tool: "subagent",
			args: { agent: writer, name, task: "Write.", background: true },
		});
		real.script("main", [
			{ calls: [launch("w1"), launch("w2")] },
			{ tool: "subagent_integrate", args: { agent: "w1" }, until: reported },
			{
				calls: [
					{ tool: "subagent_stop", args: { agent: "w2" } },
					{ tool: "subagent_integrate", args: { agent: "w2" } },
				],
			},
			{ tool: "subagent_integrate", args: { agent: "w2" } },
			{ tool: "subagent_integrate", args: { agent: "w1" }, until: settled },
			{ text: "done" },
			{ text: "done" },
		]);
		real.script("w1", [{ tool: "write", args: { path: "one.txt", content: "one\n" } }, { text: "Wrote." }]);
		real.script("w2", [
			{ tool: "write", args: { path: "two.txt", content: "two\n" } },
			{ text: "Never.", until: join(repo, "..", "never") },
		]);
		real.start(["--", "delegate"]);
		await waitFor(() => expect(real.requests("w1").length).toBeGreaterThan(0));
		await waitFor(() => expect(real.requests("w2").length).toBeGreaterThan(1));
		// Its Report is stored, but what its pi started still runs: its work has not settled.
		await waitFor(() => {
			const dir = runOf(real, "w1")?.dir;
			return dir !== undefined && reportSeqs(dir).length > 0;
		});
		expect(runOf(real, "w1")?.status).toBe("running");
		writeFileSync(reported, "");

		await real.waitForRequests("main", 5);
		await waitFor(() => expect(runOf(real, "w1")?.status).toBe("closed"));
		writeFileSync(settled, "");
		await waitFor(() => expect(real.requests("main").length).toBeGreaterThanOrEqual(6));
		const results = toolResults(real.requests("main")[5]);
		const [early, stopped, stopping, cancelled, late] = results.slice(2);
		expect(early).toMatch(/^Not integrated: "w1" \(sub_[\w-]+\) is still running/);
		expect(stopped).toMatch(/^Stopped "w2"/);
		expect(stopping).toMatch(/^Not integrated: "w2" \(sub_[\w-]+\) is still stopping/);
		expect(cancelled).toMatch(/^Not integrated: "w2" \(sub_[\w-]+\) ended cancelled .*not ready to integrate/s);
		expect(late).toMatch(/^Integration: applied A one\.txt to /m);
		expect(read(repo, "one.txt")).toBe("one\n");
		expect(existsSync(join(repo, "two.txt"))).toBe(false);
	});

	// Four pis one after another (hw, hrev, cw, then crev): a readiness bound for each to start, and one for the rest.
	it(
		"integrates a chain once every step completed, never a halted one or a step on its own",
		{ timeout: 5 * readinessMs },
		async () => {
			const real = await startOrchestrator();
			pi = real;
			const repo = real.cwd;
			repository(repo, { "a.txt": SEVEN });
			const chain = (worker: string, reviewer: string) => ({
				tool: "subagent",
				args: {
					chain: [
						{ agent: writer, name: worker, task: "Write." },
						{ agent: "reviewer", name: reviewer, task: "Review." },
					],
				},
			});
			real.script("main", [chain("hw", "hrev"), chain("cw", "crev"), { text: "two chains" }]);
			real.script("hw", [{ tool: "write", args: { path: "halted.txt", content: "halted\n" } }, { text: "Wrote." }]);
			real.script("hrev", [{ text: "Half a review.", error: "the faux provider broke" }]);
			real.script("cw", [{ tool: "write", args: { path: "done.txt", content: "done\n" } }, { text: "Wrote." }]);
			real.script("crev", [{ text: "Looks right." }]);
			const pane = real.start(["--", "delegate"]);
			// Each step's pi start gets a readiness wait of its own.
			for (const step of ["hw", "hrev", "cw", "crev"]) {
				await waitFor(() => expect(real.requests(step).length).toBeGreaterThan(0));
			}
			const first = await real.waitForRequests("main", 3);
			const [halted, completed] = chainIds(first[2]);
			expect([halted, completed].every(Boolean)).toBe(true);

			real.script("main", [
				chain("hw", "hrev"),
				chain("cw", "crev"),
				{ text: "two chains" },
				{
					calls: [
						{ tool: "subagent_integrate", args: { agent: halted } },
						{ tool: "subagent_integrate", args: { agent: "cw" } },
					],
				},
				{ tool: "subagent_integrate", args: { agent: completed } },
				{ text: "done" },
			]);
			real.tmux.sendKeys(pane, ["integrate", "Enter"]);
			const main = await real.waitForRequests("main", 6);
			const [refusedHalted, refusedStep, applied] = toolResults(main[5]).slice(2);
			expect(refusedHalted).toMatch(new RegExp(`^Not integrated: chain ${halted} halted \\(chain\\[1\\] failed\\)`));
			expect(refusedStep).toMatch(new RegExp(`is a step of chain ${completed}: integrate the chain`));
			expect(applied).toMatch(/^Integration: applied A done\.txt to /m);
			expect(applied).toMatch(new RegExp(`^Run: chain ${completed}, 2 steps, every one completed`, "m"));
			expect(read(repo, "done.txt")).toBe("done\n");
			expect(existsSync(join(repo, "halted.txt"))).toBe(false);
		},
	);

	it("writes nothing the orchestrator's deny rules forbid now, or through a link in its checkout", async () => {
		const real = await startOrchestrator();
		pi = real;
		const repo = real.cwd;
		repository(repo, { "a.txt": SEVEN });
		const outside = join(repo, "..", "outside");
		mkdirSync(outside);
		const gate = join(repo, "..", "changed");
		real.script("main", [
			{ tool: "subagent", args: { agent: writer, name: "w", task: "Write." } },
			{ tool: "subagent_integrate", args: { agent: "w" }, until: gate },
			{ tool: "subagent_integrate", args: { agent: "w", keep: ["locked.txt", "lib/x.txt"] } },
			{ text: "done" },
		]);
		real.script("w", [
			{
				calls: [
					{ tool: "write", args: { path: "locked.txt", content: "locked\n" } },
					{ tool: "write", args: { path: "lib/x.txt", content: "x\n" } },
					{ tool: "write", args: { path: "free.txt", content: "free\n" } },
				],
			},
			{ text: "Wrote." },
		]);
		real.start(["--", "delegate"]);
		await real.waitForRequests("main", 2);
		// Since the run was admitted: a rule against one of its files, and a link where it made a directory.
		const settings = join(real.agentDir, "settings.json");
		writeFileSync(
			settings,
			JSON.stringify({ ...JSON.parse(readFileSync(settings, "utf8")), permissions: { deny: ["Edit(locked.txt)"] } }),
		);
		symlinkSync(outside, join(repo, "lib"));
		writeFileSync(gate, "");

		const main = await real.waitForRequests("main", 4);
		const [, refused, applied] = toolResults(main[3]);
		expect(refused).toMatch(/^Not integrated: nothing of .* was applied/);
		expect(refused).toMatch(/^- locked\.txt: Blocked by permission rule \(deny\): Edit\(locked\.txt\)/m);
		expect(refused).toMatch(/^- lib\/x\.txt: .*lib is a link in your checkout/m);
		expect(readdirSync(outside)).toEqual([]);
		expect(existsSync(join(repo, "locked.txt"))).toBe(false);
		// Left as they are in the checkout, the rest goes in, still through no link.
		expect(applied).toMatch(/^Integration: applied A free\.txt to /m);
		expect(applied).toMatch(/^Kept as in your checkout: locked\.txt, lib\/x\.txt$/m);
		expect(read(repo, "free.txt")).toBe("free\n");
		expect(readdirSync(outside)).toEqual([]);
		expect(existsSync(join(repo, "locked.txt"))).toBe(false);
	});

	// Two pis one after another (w1, then w2): a readiness bound for each to start, and one for the rest.
	it(
		"runs the check after pi's shellCommandPrefix, as its bash does, and holds it to deny rules as the model wrote it",
		{ timeout: 3 * readinessMs },
		async () => {
			const real = await startOrchestrator();
			pi = real;
			const repo = real.cwd;
			repository(repo, { "a.txt": SEVEN });
			const gate = join(repo, "..", "prefixed");
			const check = 'test "$PFX" = applied';
			real.script("main", [
				{ tool: "subagent", args: { agent: writer, name: "w1", task: "Write." } },
				{ tool: "subagent_integrate", args: { agent: "w1", check } },
				{ tool: "subagent", args: { agent: writer, name: "w2", task: "Write." }, until: gate },
				{ tool: "subagent_integrate", args: { agent: "w2", check } },
				{ text: "done" },
			]);
			real.script("w1", [{ tool: "write", args: { path: "one.txt", content: "1\n" } }, { text: "Wrote." }]);
			real.script("w2", [{ tool: "write", args: { path: "two.txt", content: "2\n" } }, { text: "Wrote." }]);
			real.start(["--", "delegate"]);
			await real.waitForRequests("main", 3);
			// A rule the prefixed command would match, but the model's command does not.
			const settings = join(real.agentDir, "settings.json");
			writeFileSync(
				settings,
				JSON.stringify({
					...JSON.parse(readFileSync(settings, "utf8")),
					shellCommandPrefix: "export PFX=applied",
					permissions: { deny: ["Bash(export *)"] },
				}),
			);
			writeFileSync(gate, "");

			const main = await real.waitForRequests("main", 5);
			const [, without, , prefixed] = toolResults(main[4]);
			expect(without).toContain(`Validation: \`${check}\` exited with code 1`);
			expect(prefixed).toContain(`Validation: \`${check}\` exited with code 0`);
		},
	);

	it("runs no check for an orchestrator that may not run bash itself, and says why", async () => {
		const real = await startOrchestrator();
		pi = real;
		const repo = real.cwd;
		repository(repo, { "a.txt": SEVEN });
		real.script("main", [
			{ tool: "subagent", args: { agent: writer, name: "w", task: "Write." } },
			{ tool: "subagent_integrate", args: { agent: "w", check: "touch checked" } },
			{ text: "done" },
		]);
		real.script("w", [{ tool: "write", args: { path: "n.txt", content: "new\n" } }, { text: "Wrote." }]);
		real.start(["--exclude-tools", "bash", "--", "delegate"]);

		const main = await real.waitForRequests("main", 3);
		const applied = toolResults(main[2])[1];
		expect(applied).toMatch(/^Integration: applied A n\.txt to /m);
		expect(applied).toMatch(/^Validation: `touch checked` did not run: your bash tool is not active/m);
		expect(existsSync(join(repo, "checked"))).toBe(false);
	});

	it("reports that Git could not merge when its merge step gives no tree, and applies nothing", async () => {
		const real = await startOrchestrator();
		pi = real;
		const repo = real.cwd;
		repository(repo, { "a.txt": SEVEN });
		// A git whose merge step exits 1 and prints no tree, as git before 2.45 does when given trees. Outside the
		// test's directory: a PATH that names it would make the teardown's `ps` take itself for a leftover.
		const bin = mkdtempSync(join(tmpdir(), "bc-git-"));
		onTestFinished(() => rmSync(bin, { recursive: true, force: true }));
		const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
		writeFileSync(
			join(bin, "git"),
			`#!/bin/sh\nfor arg; do [ "$arg" = merge-tree ] && { echo 'error: no merge here' >&2; exit 1; }; done\nexec '${realGit}' "$@"\n`,
			{ mode: 0o755 },
		);
		vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
		const before = gitState(repo);
		real.script("main", [
			{ tool: "subagent", args: { agent: writer, name: "w", task: "Edit." } },
			{ tool: "subagent_integrate", args: { agent: "w" } },
			{ text: "done" },
		]);
		real.script("w", [
			{ tool: "edit", args: { path: "a.txt", edits: [{ oldText: "4\n", newText: "4 run\n" }] } },
			{ tool: "write", args: { path: "n.txt", content: "new\n" } },
			{ text: "Edited." },
		]);
		real.start(["--", "delegate"]);

		const main = await real.waitForRequests("main", 3);
		expect(toolResults(main[2])[1]).toBe(
			"Not integrated: Git could not merge (error: no merge here). Nothing more was applied.",
		);
		expect(read(repo, "a.txt")).toBe(SEVEN);
		expect(existsSync(join(repo, "n.txt"))).toBe(false);
		expect(gitState(repo)).toBe(before);
	});

	it.skipIf(process.platform !== "darwin")(
		"integrates a run whose shell is contained once none of its commands' processes runs",
		async () => {
			const real = await startOrchestrator();
			pi = real;
			const repo = real.cwd;
			repository(repo, { "a.txt": SEVEN });
			real.script("main", [
				{ tool: "subagent", args: { agent: "general-purpose", name: "gp", task: "Make it." } },
				{ tool: "subagent_integrate", args: { agent: "gp", check: "cat made.txt" } },
				{ text: "done" },
			]);
			real.script("gp", [{ tool: "bash", args: { command: "printf made > made.txt" } }, { text: "Made it." }]);
			real.start(["--", "delegate"]);
			const main = await real.waitForRequests("main", 3);
			const applied = toolResults(main[2])[1];
			expect(applied).toMatch(/^Integration: applied A made\.txt to /m);
			expect(applied).toMatch(/^Validation: `cat made\.txt` exited with code 0 .*\nIts output:\nmade$/m);
			expect(read(repo, "made.txt")).toBe("made");
		},
	);
});
