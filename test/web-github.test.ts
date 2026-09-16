import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fetchGithub, type GithubRunner, type GithubTarget, parseGithubUrl } from "../ext/web/github.ts";

type Call = { cmd: string; args: string[]; timeoutMs: number };
type Reply = { code?: number; stdout?: string; stderr?: string; effect?: (args: string[]) => void };

/** A fake runner answering by the first matching `cmd args` prefix; records every call. */
function fakeRunner(replies: Array<[string, Reply]>) {
	const calls: Call[] = [];
	const run: GithubRunner = async (cmd, args, opts) => {
		calls.push({ cmd, args, timeoutMs: opts.timeoutMs });
		const line = `${cmd} ${args.join(" ")}`;
		const hit = replies.find(([prefix]) => line.startsWith(prefix));
		if (!hit) return { code: 1, stdout: "", stderr: `unexpected: ${line}` };
		hit[1].effect?.(args);
		return { code: hit[1].code ?? 0, stdout: hit[1].stdout ?? "", stderr: hit[1].stderr ?? "" };
	};
	return { run, calls };
}

const b64 = (s: string) => Buffer.from(s).toString("base64");
const json = (v: unknown) => JSON.stringify(v);

const tempDirs: string[] = [];
function tempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "web-github-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseGithubUrl", () => {
	const cases: Array<[string, GithubTarget | undefined]> = [
		["https://github.com/o/r", { kind: "repo", owner: "o", repo: "r" }],
		["https://github.com/o/r/", { kind: "repo", owner: "o", repo: "r" }],
		["https://www.github.com/o/r.git", { kind: "repo", owner: "o", repo: "r" }],
		["https://github.com/o/r?tab=readme#top", { kind: "repo", owner: "o", repo: "r" }],
		["https://github.com/o/r/tree/main", { kind: "repo", owner: "o", repo: "r", ref: "main" }],
		["https://github.com/o/r/tree/main/", { kind: "repo", owner: "o", repo: "r", ref: "main" }],
		[
			"https://github.com/o/r/tree/v1.2/src/lib",
			{ kind: "repo", owner: "o", repo: "r", ref: "v1.2", path: "src/lib" },
		],
		[
			"https://github.com/o/r/blob/main/src/a.ts#L10",
			{ kind: "file", owner: "o", repo: "r", ref: "main", path: "src/a.ts" },
		],
		[
			"https://github.com/o/r/blob/feature%2Fx/a%20b.md",
			{ kind: "file", owner: "o", repo: "r", ref: "feature/x", path: "a b.md" },
		],
		["https://github.com/o/r/issues/42", { kind: "issue", owner: "o", repo: "r", number: 42 }],
		["https://github.com/o/r/issues/42#issuecomment-1", { kind: "issue", owner: "o", repo: "r", number: 42 }],
		["https://github.com/o/r/pull/7", { kind: "pull", owner: "o", repo: "r", number: 7 }],
		["https://github.com/o/r/pull/7/files", { kind: "pull", owner: "o", repo: "r", number: 7 }],
		["https://github.com/o/r/blob/main", undefined],
		["https://github.com/o/r/blob/-x/a.ts", undefined],
		["https://github.com/o/r/blob/main/%2E%2E/a.ts", undefined],
		["https://github.com/o/r/issues", undefined],
		["https://github.com/o/r/issues/abc", undefined],
		["https://github.com/o/r/issues/0", undefined],
		["https://github.com/o/r/pull/7/unknown", undefined],
		["https://github.com/o/r/pulls", undefined],
		["https://github.com/o/r/wiki", undefined],
		["https://github.com/o/r/releases/tag/v1", undefined],
		["https://github.com/o/r/discussions/3", undefined],
		["https://github.com/o/r/settings", undefined],
		["https://github.com/o/r/actions", undefined],
		["https://github.com/orgs/acme/repositories", undefined],
		["https://github.com/settings/profile", undefined],
		["https://github.com/o", undefined],
		["https://github.com/", undefined],
		["https://gist.github.com/o/abc123", undefined],
		["https://raw.githubusercontent.com/o/r/main/a.ts", undefined],
		["https://example.com/o/r", undefined],
		["https://github.com.evil.com/o/r", undefined],
		["https://github.com/-bad/r", undefined],
	];
	it.each(cases)("%s", (url, expected) => {
		expect(parseGithubUrl(new URL(url))).toEqual(expected);
	});
});

describe("fetchGithub: file", () => {
	const target: GithubTarget = { kind: "file", owner: "o", repo: "r", ref: "main", path: "src/a.ts" };

	it("decodes base64 into a fenced block with the language", async () => {
		const content = "const a = 1;\n// ```inner```\n";
		const { run, calls } = fakeRunner([
			[
				"gh api repos/o/r/contents/src/a.ts?ref=main",
				{ stdout: json({ type: "file", size: content.length, encoding: "base64", content: b64(content) }) },
			],
		]);
		const out = await fetchGithub(target, { allowClone: false, run });
		expect(out?.text).toContain("````typescript\nconst a = 1;");
		expect(out?.text.trimEnd().endsWith("````")).toBe(true);
		expect(calls).toHaveLength(1);
	});

	it("gives up on files over 1MB, binaries, and missing gh", async () => {
		const big = fakeRunner([
			["gh api", { stdout: json({ type: "file", size: 2_000_000, encoding: "none", content: "" }) }],
		]);
		expect(await fetchGithub(target, { allowClone: false, run: big.run })).toBeUndefined();
		const bin = fakeRunner([
			["gh api", { stdout: json({ type: "file", size: 3, encoding: "base64", content: b64("a\0b") }) }],
		]);
		expect(await fetchGithub(target, { allowClone: false, run: bin.run })).toBeUndefined();
		const missing = fakeRunner([["gh", { code: 127 }]]);
		expect(await fetchGithub(target, { allowClone: false, run: missing.run })).toBeUndefined();
	});
});

describe("fetchGithub: repository", () => {
	const target: GithubTarget = { kind: "repo", owner: "o", repo: "r" };

	it("lists through the gh API when cloning is not allowed", async () => {
		const { run, calls } = fakeRunner([
			[
				"gh api repos/o/r/contents",
				{
					stdout: json([
						{ name: "z.ts", type: "file" },
						{ name: "src", type: "dir" },
					]),
				},
			],
			["gh api repos/o/r/readme", { stdout: json({ type: "file", encoding: "base64", content: b64("# Hello") }) }],
		]);
		const out = await fetchGithub(target, { allowClone: false, run });
		expect(out?.text).toContain("# o/r");
		expect(out?.text).toMatch(/src\/\nz\.ts/);
		expect(out?.text).toContain("# Hello");
		expect(out?.note).toContain("not cloned (cloning is not allowed here)");
		expect(calls.some((c) => c.cmd === "git")).toBe(false);
		expect(calls[0].args[1]).toBe("repos/o/r/contents");
	});

	it("passes path and ref to the contents and readme endpoints", async () => {
		const { run, calls } = fakeRunner([["gh api", { stdout: json([]) }]]);
		await fetchGithub({ kind: "repo", owner: "o", repo: "r", ref: "dev", path: "a b/c" }, { allowClone: false, run });
		expect(calls.map((c) => c.args[1])).toEqual([
			"repos/o/r/contents/a%20b/c?ref=dev",
			"repos/o/r/readme/a%20b/c?ref=dev",
		]);
	});

	it("does not clone a repository over 350MB", async () => {
		const { run, calls } = fakeRunner([
			["gh api repos/o/r --jq .size", { stdout: `${400 * 1024}\n` }],
			["gh api repos/o/r/contents", { stdout: json([{ name: "a", type: "file" }]) }],
		]);
		const out = await fetchGithub(target, { allowClone: true, run, cloneRoot: tempRoot() });
		expect(out?.note).toContain("400 MB, over the 350 MB clone limit");
		expect(calls.some((c) => c.cmd === "git")).toBe(false);
	});

	it("returns undefined when gh is missing and nothing can be listed", async () => {
		const { run } = fakeRunner([["gh", { code: 127 }]]);
		expect(await fetchGithub(target, { allowClone: true, run, cloneRoot: tempRoot() })).toBeUndefined();
		expect(await fetchGithub(target, { allowClone: false, run })).toBeUndefined();
	});

	it("clones shallowly with hooks disabled, then renders tree and README", async () => {
		const root = tempRoot();
		const { run, calls } = fakeRunner([
			["gh api repos/o/r --jq .size", { stdout: "1024\n" }],
			[
				"git -c core.hooksPath=/dev/null clone",
				{
					effect: (args) => {
						const dir = args[args.length - 1];
						mkdirSync(join(dir, ".git", "objects"), { recursive: true });
						mkdirSync(join(dir, "src", "deep", "deeper", "deepest"), { recursive: true });
						writeFileSync(join(dir, "src", "deep", "deeper", "deepest", "hidden.ts"), "");
						writeFileSync(join(dir, "README.md"), "# Readme body");
						writeFileSync(join(dir, "zz-last.json"), "");
						mkdirSync(join(dir, "many"));
						for (let i = 0; i < 310; i++) writeFileSync(join(dir, "many", `f${i}.txt`), "");
					},
				},
			],
		]);
		const out = await fetchGithub({ ...target, ref: "dev" }, { allowClone: true, run, cloneRoot: root });
		const clone = calls.find((c) => c.cmd === "git");
		const dir = join(root, "o-r-dev");
		expect(clone?.args).toEqual([
			"-c",
			"core.hooksPath=/dev/null",
			"clone",
			"--depth",
			"1",
			"--single-branch",
			"--no-tags",
			"--branch=dev",
			"https://github.com/o/r.git",
			dir,
		]);
		expect(clone?.timeoutMs).toBe(30_000);
		expect(out?.note).toBe(`[webfetch: repository cloned to ${dir} — use read/grep/find there]`);
		expect(out?.text).toContain("## README.md\n\n# Readme body");
		expect(out?.text).not.toContain(".git/");
		expect(out?.text).not.toContain("hidden.ts"); // beyond the depth limit
		// Breadth-first budget: the big many/ dir cannot push top-level files out.
		expect(out?.text).toContain("\nzz-last.json\n");
		expect(out?.text).toContain("  f0.txt");
		expect(out?.text).toMatch(/\n {2}… 1[0-9] more\n/);

		// A second fetch reuses the checkout without touching gh or git.
		const again = fakeRunner([]);
		const reused = await fetchGithub(
			{ ...target, ref: "dev" },
			{ allowClone: true, run: again.run, cloneRoot: root },
		);
		expect(reused?.note).toContain(dir);
		expect(again.calls).toHaveLength(0);
	});

	it("renders a subdirectory of a clone and skips a symlinked README", async () => {
		const root = tempRoot();
		const dir = join(root, "o-r-default");
		mkdirSync(join(dir, ".git"), { recursive: true });
		mkdirSync(join(dir, "pkg"));
		writeFileSync(join(dir, "pkg", "index.ts"), "");
		const secret = join(root, "secret.txt");
		writeFileSync(secret, "SECRET");
		symlinkSync(secret, join(dir, "pkg", "README.md"));
		const { run } = fakeRunner([]);
		const out = await fetchGithub({ ...target, path: "pkg" }, { allowClone: true, run, cloneRoot: root });
		expect(out?.text).toContain("index.ts");
		expect(out?.text).not.toContain("SECRET");
	});

	it("falls back to the API when git clone fails, and removes the partial dir", async () => {
		const root = tempRoot();
		const { run } = fakeRunner([
			["gh api repos/o/r --jq .size", { stdout: "10" }],
			[
				"git",
				{
					code: 128,
					stderr: "Cloning...\nfatal: Remote branch nope not found",
					effect: (args) => mkdirSync(args[args.length - 1], { recursive: true }),
				},
			],
			["gh api repos/o/r/contents", { stdout: json([]) }],
		]);
		const out = await fetchGithub({ ...target, ref: "nope" }, { allowClone: true, run, cloneRoot: root });
		expect(out?.note).toContain("git clone failed: fatal: Remote branch nope not found");
		expect(() => mkdirSync(join(root, "o-r-nope"))).not.toThrow();
	});

	it("skips cloning for a commit SHA ref", async () => {
		const { run, calls } = fakeRunner([["gh api repos/o/r/contents", { stdout: json([]) }]]);
		const out = await fetchGithub(
			{ ...target, ref: "a".repeat(40) },
			{ allowClone: true, run, cloneRoot: tempRoot() },
		);
		expect(out?.note).toContain("commit SHA");
		expect(calls.some((c) => c.cmd === "git" || c.args.includes(".size"))).toBe(false);
	});
});

describe("fetchGithub: issues and pull requests", () => {
	it("renders an issue with body before comments and caps the comments", async () => {
		const comments = Array.from({ length: 35 }, (_, i) => ({
			author: { login: `u${i}` },
			body: `comment ${i}`,
			createdAt: "2026-01-01",
		}));
		const { run, calls } = fakeRunner([
			[
				"gh issue view 5 -R o/r --json title,state,author,body,comments,labels,createdAt",
				{
					stdout: json({
						title: "Broken",
						state: "OPEN",
						author: { login: "alice" },
						body: "It breaks.",
						labels: [{ name: "bug" }],
						createdAt: "2026-01-01",
						comments,
					}),
				},
			],
		]);
		const out = await fetchGithub({ kind: "issue", owner: "o", repo: "r", number: 5 }, { allowClone: false, run });
		const text = out?.text ?? "";
		expect(calls).toHaveLength(1);
		expect(text.startsWith("# Issue #5: Broken")).toBe(true);
		expect(text).toContain("Author: @alice");
		expect(text).toContain("Labels: bug");
		expect(text.indexOf("It breaks.")).toBeLessThan(text.indexOf("## Comments (35)"));
		expect(text).toContain("comment 29");
		expect(text).not.toContain("comment 30");
		expect(text).toContain("… 5 more");
	});

	it("renders a pull request in priority order and caps files and total size", async () => {
		const files = Array.from({ length: 120 }, (_, i) => ({ path: `f${i}.ts`, additions: 1, deletions: 0 }));
		const { run, calls } = fakeRunner([
			[
				"gh pr view 9 -R o/r --json",
				{
					stdout: json({
						title: "Add thing",
						state: "MERGED",
						author: { login: "bob" },
						body: "Adds the thing.",
						headRefName: "feat",
						baseRefName: "main",
						additions: 120,
						deletions: 0,
						statusCheckRollup: [
							{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
							{ __typename: "StatusContext", context: "lint", state: "FAILURE" },
						],
						files,
						reviews: [{ author: { login: "carol" }, state: "APPROVED", body: "LGTM" }],
						comments: [{ author: { login: "dave" }, body: "x".repeat(4_000) }].concat(
							Array.from({ length: 29 }, () => ({ author: { login: "eve" }, body: "y".repeat(3_900) })),
						),
					}),
				},
			],
		]);
		const out = await fetchGithub({ kind: "pull", owner: "o", repo: "r", number: 9 }, { allowClone: false, run });
		const text = out?.text ?? "";
		expect(calls[0].args).toContain(
			"title,state,author,body,comments,reviews,files,additions,deletions,headRefName,baseRefName,statusCheckRollup",
		);
		const order = [
			"# Pull request #9",
			"Adds the thing.",
			"## Checks",
			"## Changed files (120)",
			"## Reviews",
			"## Comments",
		];
		const positions = order.map((s) => text.indexOf(s));
		expect(positions.every((p) => p >= 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
		expect(text).toContain("2 checks: 1 success, 1 failure");
		expect(text).toContain("- lint: FAILURE");
		expect(text).toContain("f99.ts");
		expect(text).not.toContain("f100.ts");
		expect(text).toContain("… 20 more");
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(60_100);
		expect(text).toContain("[… truncated at 60000 bytes]");
	});

	it("returns undefined when gh fails", async () => {
		const { run } = fakeRunner([["gh", { code: 1, stderr: "not logged in" }]]);
		expect(
			await fetchGithub({ kind: "pull", owner: "o", repo: "r", number: 1 }, { allowClone: false, run }),
		).toBeUndefined();
	});
});

describe("fetchGithub: abort", () => {
	it("throws when the signal aborts during a command", async () => {
		const controller = new AbortController();
		const run: GithubRunner = async () => {
			controller.abort();
			return { code: 1, stdout: "", stderr: "" };
		};
		await expect(
			fetchGithub(
				{ kind: "issue", owner: "o", repo: "r", number: 1 },
				{ allowClone: false, run, signal: controller.signal },
			),
		).rejects.toThrow();
	});
});
