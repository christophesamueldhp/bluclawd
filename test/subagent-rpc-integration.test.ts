import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversation, FAUX, type FauxRequest, hasTmux, type RealPi, startRealPi } from "./helpers/real-pi.ts";
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

/** An orchestrator pane whose runs are RPC children. */
async function startOrchestrator(): Promise<RealPi> {
	vi.stubEnv("BLUCLAWD_RPC_RUNS", "1");
	vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", FAUX);
	return startRealPi();
}

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
});
