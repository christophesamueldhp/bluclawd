import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	captureCheckpoint,
	checkpointForTurn,
	factory,
	isGitRepo,
	listCheckpoints,
	pruneCheckpointRefs,
	restoreCheckpoint,
} from "../ext/checkpoints/index.ts";

type Exec = ExtensionAPI["exec"];

// ── harness ──────────────────────────────────────────────────────────────────

/** Keep the user's real git config out of the fixtures (hooksPath, gpgsign, fsmonitor, ...). */
const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_TERMINAL_PROMPT: "0",
};

/** Same contract as pi's (unexported) execCommand: resolves {code, stdout, stderr, killed}, never rejects. */
function makeExec(extraEnv: Record<string, string> = {}): Exec {
	return (command, args, options) =>
		new Promise((resolve) => {
			execFile(
				command,
				args,
				{
					cwd: options?.cwd,
					timeout: options?.timeout,
					env: { ...GIT_ENV, ...extraEnv },
					maxBuffer: 64 * 1024 * 1024,
				},
				(error, stdout, stderr) => {
					const err = error as (Error & { code?: unknown; killed?: boolean }) | null;
					const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
					resolve({ stdout, stderr, code, killed: Boolean(err?.killed) });
				},
			);
		});
}

/** Fail the first exec whose args contain `marker`; pass everything else through. */
function failOnce(exec: Exec, marker: string): Exec {
	let fired = false;
	return async (command, args, options) => {
		if (!fired && args.includes(marker)) {
			fired = true;
			return { stdout: "", stderr: "injected failure", code: 1, killed: false };
		}
		return exec(command, args, options);
	};
}

const cleanups: string[] = [];
afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRepo(opts: { commit?: boolean } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "bluclawd-cp-test-"));
	cleanups.push(dir);
	const exec = makeExec();
	const git = async (...args: string[]): Promise<string> => {
		const r = await exec("git", args, { cwd: dir });
		if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
		return r.stdout;
	};
	const write = (name: string, content: string) => writeFile(join(dir, name), content);
	const read = (name: string) => readFile(join(dir, name), "utf8");
	const status = async () => (await git("status", "--porcelain")).split("\n").filter(Boolean).sort();
	await git("init", "-q");
	await git("config", "user.email", "test@bluclawd.local");
	await git("config", "user.name", "bluclawd test");
	if (opts.commit !== false) {
		await write("a.txt", "base\n");
		await git("add", "-A");
		await git("commit", "-q", "-m", "init");
	}
	return { dir, exec, git, write, read, status };
}

const SESSION = "session-a";

/** Capture with the real function and assert it worked, so failures point at capture, not the test. */
async function capture(dir: string, exec: Exec): Promise<string> {
	const sha = await captureCheckpoint(dir, exec, SESSION);
	expect(sha).toMatch(/^[0-9a-f]{40}$/);
	return sha as string;
}

/** A checkpoint-shaped commit of the current index, dated `daysAgo` days back, not yet under any ref. */
async function commitAt(dir: string, daysAgo: number): Promise<string> {
	const date = `${Math.floor(Date.now() / 1000) - daysAgo * 86400} +0000`;
	const exec = makeExec({
		GIT_AUTHOR_DATE: date,
		GIT_COMMITTER_DATE: date,
		GIT_AUTHOR_NAME: "x",
		GIT_AUTHOR_EMAIL: "x@x",
		GIT_COMMITTER_NAME: "x",
		GIT_COMMITTER_EMAIL: "x@x",
	});
	const tree = (await exec("git", ["write-tree"], { cwd: dir })).stdout.trim();
	const commit = await exec("git", ["commit-tree", tree, "-m", `fixture ${daysAgo}d`], { cwd: dir });
	expect(commit.code).toBe(0);
	return commit.stdout.trim();
}

let nextEntryId = 1;
function userEntry(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: text, timestamp: Date.now() },
	} as unknown as SessionEntry;
}
function checkpointEntry(sha: string, turnEntryId: string, subject: string, id = `cp${nextEntryId++}`): SessionEntry {
	return {
		type: "custom",
		customType: "checkpoint",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		data: { sha, turnEntryId, subject },
	} as SessionEntry;
}

/** Drive `factory(pi)` with a recording stub; `appendEntry` lands on the same `entries` array `getBranch` returns. */
function loadFactory(exec: Exec, entries: SessionEntry[]) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const pi = {
		exec,
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) =>
			handlers.set(event, handler),
		registerCommand: (name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
			commands.set(name, def.handler),
		appendEntry: (customType: string, data: unknown) => {
			entries.push({
				type: "custom",
				customType,
				data,
				id: `appended${nextEntryId++}`,
				parentId: entries.at(-1)?.id ?? null,
				timestamp: new Date().toISOString(),
			} as SessionEntry);
		},
	} as unknown as ExtensionAPI;
	factory(pi);
	return { handlers, commands };
}

/**
 * Scripted UI: `select` answers are option indexes (or option labels), `confirm` answers are booleans, both
 * consumed in order.
 */
function makeCtx(
	dir: string,
	entries: SessionEntry[],
	script: { select?: Array<number | string>; confirm?: boolean[] } = {},
) {
	const selects = [...(script.select ?? [])];
	const confirms = [...(script.confirm ?? [])];
	const notices: Array<{ message: string; type?: string }> = [];
	const navigated: string[] = [];
	const confirmMessages: string[] = [];
	const selectCalls: Array<{ title: string; options: string[] }> = [];
	const ctx = {
		cwd: dir,
		hasUI: true,
		ui: {
			select: async (title: string, options: string[]) => {
				selectCalls.push({ title, options });
				const pick = selects.shift();
				if (typeof pick === "string") return options.includes(pick) ? pick : undefined;
				const i = pick;
				return i === undefined ? undefined : options[i];
			},
			confirm: async (_title: string, message: string) => {
				confirmMessages.push(message);
				return confirms.shift() ?? false;
			},
			notify: (message: string, type?: string) => notices.push({ message, type }),
			input: async () => undefined,
		},
		sessionManager: { getBranch: () => entries, getLeafEntry: () => entries.at(-1), getSessionId: () => SESSION },
		navigateTree: async (id: string) => {
			navigated.push(id);
			return { cancelled: false };
		},
	} as unknown as ExtensionContext;
	return { ctx, notices, navigated, confirmMessages, selectCalls };
}

const appendedSubjects = (entries: SessionEntry[]) => listCheckpoints(entries).map((c) => c.subject);

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!condition() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

// ── unit: pure helpers ───────────────────────────────────────────────────────

describe("listCheckpoints", () => {
	it("keeps only checkpoint entries with a sha, newest first, with defaults filled in", () => {
		const entries: SessionEntry[] = [
			userEntry("u1", "first"),
			checkpointEntry("a".repeat(40), "u1", "first", "c1"),
			{
				type: "custom",
				customType: "other",
				id: "x",
				parentId: null,
				timestamp: "t",
				data: { sha: "z" },
			} as SessionEntry,
			{
				type: "custom",
				customType: "checkpoint",
				id: "bad",
				parentId: null,
				timestamp: "t",
				data: {},
			} as SessionEntry,
			{
				type: "custom",
				customType: "checkpoint",
				id: "c2",
				parentId: null,
				timestamp: "t2",
				data: { sha: "b".repeat(40) },
			} as SessionEntry,
		];
		const list = listCheckpoints(entries);
		expect(list.map((c) => c.entryId)).toEqual(["c2", "c1"]);
		expect(list[0]).toMatchObject({ turnEntryId: "", subject: "(no subject)", timestamp: "t2" });
		expect(list[1]).toMatchObject({ turnEntryId: "u1", subject: "first" });
	});
});

describe("checkpointForTurn", () => {
	it("returns the OLDEST checkpoint of a turn — the tree before the prompt did anything", () => {
		const entries = [
			userEntry("u1", "do work"),
			checkpointEntry("1".repeat(40), "u1", "do work", "older"),
			checkpointEntry("2".repeat(40), "u1", "do work", "newer"),
			userEntry("u2", "more"),
			checkpointEntry("3".repeat(40), "u2", "more", "other-turn"),
		];
		expect(checkpointForTurn(entries, "u1")?.entryId).toBe("older");
		expect(checkpointForTurn(entries, "u2")?.entryId).toBe("other-turn");
	});

	it("returns undefined when the turn has no checkpoint", () => {
		expect(checkpointForTurn([userEntry("u1", "x")], "u1")).toBeUndefined();
	});
});

// ── integration: exported git functions ──────────────────────────────────────

describe("captureCheckpoint", () => {
	it("returns undefined outside a git repository", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bluclawd-cp-nogit-"));
		cleanups.push(dir);
		const exec = makeExec();
		expect(await isGitRepo(dir, exec)).toBe(false);
		expect(await captureCheckpoint(dir, exec, SESSION)).toBeUndefined();
	});

	it("never changes git status or the real index, and leaves no temp index behind", async () => {
		const { dir, exec, write, status } = await makeRepo();
		await write("a.txt", "edited\n");
		await write("new.txt", "new\n");
		const statusBefore = await status();
		const indexBefore = await readFile(join(dir, ".git", "index"));

		await capture(dir, exec);

		const indexAfter = await readFile(join(dir, ".git", "index"));
		expect(indexAfter.equals(indexBefore)).toBe(true);
		expect(await status()).toEqual(statusBefore);
		expect(statusBefore).toEqual([" M a.txt", "?? new.txt"]);
		const leftovers = (await readdir(tmpdir())).filter((f) => f.startsWith("bluclawd-checkpoint-"));
		expect(leftovers).toEqual([]);
	});

	it("records the sha under refs/bluclawd/checkpoints/<sessionId>/ with the commit as parent", async () => {
		const { dir, exec, git } = await makeRepo();
		const sha = await capture(dir, exec);
		expect((await git("rev-parse", `refs/bluclawd/checkpoints/${SESSION}/${sha}`)).trim()).toBe(sha);
		expect((await git("rev-parse", `${sha}^`)).trim()).toBe((await git("rev-parse", "HEAD")).trim());
	});
});

describe("pruneCheckpointRefs", () => {
	it("keeps own-branch refs, drops own and legacy strays, and drops foreign refs only past the TTL", async () => {
		const { dir, exec, git, write } = await makeRepo();
		const keep = await capture(dir, exec);
		await write("a.txt", "second\n");
		const ownStray = await capture(dir, exec);
		expect(keep).not.toBe(ownStray);
		const legacy = await commitAt(dir, 0);
		await git("update-ref", `refs/bluclawd/checkpoints/${legacy}`, legacy);
		const foreignFresh = await commitAt(dir, 1);
		await git("update-ref", `refs/bluclawd/checkpoints/session-b/${foreignFresh}`, foreignFresh);
		const foreignOld = await commitAt(dir, 31);
		await git("update-ref", `refs/bluclawd/checkpoints/session-b/${foreignOld}`, foreignOld);

		expect(await pruneCheckpointRefs(dir, exec, SESSION, new Set([keep]))).toBe(3);
		const refs = (await git("for-each-ref", "--format=%(refname)", "refs/bluclawd/checkpoints/"))
			.trim()
			.split("\n")
			.sort();
		expect(refs).toEqual(
			[`refs/bluclawd/checkpoints/${SESSION}/${keep}`, `refs/bluclawd/checkpoints/session-b/${foreignFresh}`].sort(),
		);
	});

	it("keeps a legacy flat ref that the current branch still references", async () => {
		const { dir, git } = await makeRepo();
		const legacy = await commitAt(dir, 0);
		await git("update-ref", `refs/bluclawd/checkpoints/${legacy}`, legacy);
		expect(await pruneCheckpointRefs(dir, makeExec(), SESSION, new Set([legacy]))).toBe(0);
	});
});

describe("restoreCheckpoint — tracked files that match .gitignore", () => {
	it("captures their modifications and keeps them on restore", async () => {
		const { dir, exec, git, write, read } = await makeRepo();
		await write("cfg.txt", "committed\n");
		await write(".gitignore", "cfg.txt\n");
		await git("add", "-f", "cfg.txt", ".gitignore");
		await git("commit", "-q", "-m", "track cfg then ignore it");
		expect((await git("ls-files")).split("\n")).toContain("cfg.txt");
		await write("cfg.txt", "checkpointed\n");

		const sha = await capture(dir, exec);
		expect((await git("ls-tree", "--name-only", sha)).split("\n")).toContain("cfg.txt");

		await write("cfg.txt", "later\n");
		expect(await restoreCheckpoint(dir, exec, sha)).toBe(true);
		expect(await read("cfg.txt")).toBe("checkpointed\n");
	});
});

describe("restoreCheckpoint — index state afterwards", () => {
	it("leaves modified files unstaged and new files untracked; later files survive", async () => {
		const { dir, exec, write, read, status } = await makeRepo();
		await write("a.txt", "v1\n");
		await write("new.txt", "new\n");
		const sha = await capture(dir, exec);

		await write("a.txt", "v2\n");
		await write("later.txt", "later\n");
		expect(await restoreCheckpoint(dir, exec, sha)).toBe(true);

		expect(await read("a.txt")).toBe("v1\n");
		expect(await read("later.txt")).toBe("later\n");
		expect(await status()).toEqual([" M a.txt", "?? later.txt", "?? new.txt"]);
	});

	it("removes the files the replaced tree added over the checkpoint, tracked or not", async () => {
		const { dir, exec, git, write, read, status } = await makeRepo();
		await write("a.txt", "v1\n");
		const sha = await capture(dir, exec);

		await write("a.txt", "v2\n");
		await write("new.txt", "new\n");
		await mkdir(join(dir, "sub"));
		await write("sub/staged.txt", "staged\n");
		await git("add", "sub/staged.txt");
		const current = await capture(dir, exec);
		expect(await restoreCheckpoint(dir, exec, sha, current)).toBe(true);

		expect(await read("a.txt")).toBe("v1\n");
		await expect(read("new.txt")).rejects.toThrow();
		await expect(read("sub/staged.txt")).rejects.toThrow();
		expect(await status()).toEqual([" M a.txt"]);
	});

	it("removes added files anywhere in the repository when run from a subdirectory", async () => {
		const { dir, exec, write, read } = await makeRepo();
		await mkdir(join(dir, "sub"));
		await write("sub/keep.txt", "keep\n");
		const sha = await capture(dir, exec);
		await write("top-new.txt", "new\n");
		const current = await capture(dir, exec);

		expect(await restoreCheckpoint(join(dir, "sub"), exec, sha, current)).toBe(true);
		await expect(read("top-new.txt")).rejects.toThrow();
		expect(await read("sub/keep.txt")).toBe("keep\n");
	});

	it("works on an unborn HEAD (fresh git init, no commits)", async () => {
		const { dir, exec, write, read, status } = await makeRepo({ commit: false });
		await write("a.txt", "first\n");
		const sha = await capture(dir, exec);
		await write("a.txt", "changed\n");
		expect(await restoreCheckpoint(dir, exec, sha)).toBe(true);
		expect(await read("a.txt")).toBe("first\n");
		expect(await status()).toEqual(["?? a.txt"]);
	});
});

// ── integration: handlers through the factory ────────────────────────────────

describe("/rewind", () => {
	const RESTORE_BOTH = "Restore code and conversation";
	const RESTORE_TALK = "Restore conversation";
	const RESTORE_CODE = "Restore code";

	it("lists every prompt newest first with what it changed, then offers Claude Code's options", async () => {
		const { dir, exec, write } = await makeRepo();
		const first = await capture(dir, exec);
		await write("a.txt", "v1\n");
		await write("b.txt", "b\n");
		const second = await capture(dir, exec);
		const entries = [
			userEntry("u1", "make v1"),
			checkpointEntry(first, "u1", "make v1"),
			userEntry("u2", "only talk"),
			userEntry("u3", "make v2"),
			checkpointEntry(second, "u3", "make v2"),
		];
		await write("a.txt", "v2\n");

		const { commands } = loadFactory(exec, entries);
		const { ctx, selectCalls } = makeCtx(dir, entries, { select: [2] });
		await commands.get("rewind")?.("", ctx);

		expect(selectCalls[0]?.options).toEqual([
			"make v2 · a.txt +1 -1",
			"only talk · ⚠ No code restore",
			"make v1 · 2 files changed +2 -1",
		]);
		expect(selectCalls[1]?.title).toContain("Confirm you want to restore to the point before you sent this message:");
		expect(selectCalls[1]?.title).toContain("make v1");
		expect(selectCalls[1]?.title).toContain("The code will be restored +1 -2 in a.txt and b.txt.");
		expect(selectCalls[1]?.options).toEqual([RESTORE_BOTH, RESTORE_TALK, RESTORE_CODE, "Never mind"]);
	});

	it("offers only the conversation for a prompt without a checkpoint", async () => {
		const { dir, exec } = await makeRepo();
		const entries = [userEntry("u1", "chat")];

		const { commands } = loadFactory(exec, entries);
		const { ctx, selectCalls, navigated } = makeCtx(dir, entries, { select: [0, RESTORE_TALK] });
		await commands.get("rewind")?.("", ctx);

		expect(selectCalls[1]?.options).toEqual([RESTORE_TALK, "Never mind"]);
		expect(navigated).toEqual(["u1"]);
	});

	it("says there is nothing to rewind to before the first prompt", async () => {
		const { dir, exec } = await makeRepo();
		const { commands } = loadFactory(exec, []);
		const { ctx, notices, selectCalls } = makeCtx(dir, []);
		await commands.get("rewind")?.("", ctx);

		expect(selectCalls).toEqual([]);
		expect(notices.at(-1)?.message).toContain("Nothing to rewind to yet.");
	});

	it("Restore code restores without a second confirmation and keeps a safety net", async () => {
		const { dir, exec, write, read } = await makeRepo();
		await write("a.txt", "v1\n");
		const sha = await capture(dir, exec);
		const entries = [userEntry("u1", "make v1"), checkpointEntry(sha, "u1", "make v1")];
		await write("a.txt", "v2\n");

		const { commands } = loadFactory(exec, entries);
		const { ctx, notices, navigated, confirmMessages } = makeCtx(dir, entries, { select: [0, RESTORE_CODE] });
		await commands.get("rewind")?.("", ctx);

		expect(confirmMessages).toEqual([]);
		expect(await read("a.txt")).toBe("v1\n");
		expect(appendedSubjects(entries)).toContain("(before rewind)");
		expect(notices.at(-1)?.message).toContain("restored");
		expect(navigated).toEqual([]);

		// /rewind lists the safety net as a code-only row of its own, which brings v2 back.
		const undo = makeCtx(dir, entries, { select: [0, RESTORE_CODE] });
		await commands.get("rewind")?.("", undo.ctx);
		expect(undo.selectCalls[0]?.options[0]).toBe("(before rewind) · a.txt +1 -1");
		expect(undo.selectCalls[1]?.options).toEqual([RESTORE_CODE, "Never mind"]);
		expect(await read("a.txt")).toBe("v2\n");
		expect(undo.navigated).toEqual([]);
	});

	it("Restore code removes a file created after the checkpoint; undoing brings it back", async () => {
		const { dir, exec, write, read } = await makeRepo();
		const sha = await capture(dir, exec);
		const entries = [userEntry("u1", "add b"), checkpointEntry(sha, "u1", "add b")];
		await write("b.txt", "new\n");

		const { commands } = loadFactory(exec, entries);
		const { ctx, selectCalls } = makeCtx(dir, entries, { select: [0, RESTORE_CODE] });
		await commands.get("rewind")?.("", ctx);
		expect(selectCalls[1]?.title).toContain("The code will be restored +0 -1 in b.txt.");
		await expect(read("b.txt")).rejects.toThrow();

		const undo = makeCtx(dir, entries, { select: [0, RESTORE_CODE] });
		await commands.get("rewind")?.("", undo.ctx);
		expect(await read("b.txt")).toBe("new\n");
	});

	it("Never mind leaves the tree alone and appends no entry", async () => {
		const { dir, exec, write, read } = await makeRepo();
		await write("a.txt", "v1\n");
		const sha = await capture(dir, exec);
		const entries = [userEntry("u1", "make v1"), checkpointEntry(sha, "u1", "make v1")];
		await write("a.txt", "v2\n");

		const { commands } = loadFactory(exec, entries);
		const { ctx, navigated } = makeCtx(dir, entries, { select: [0, "Never mind"] });
		await commands.get("rewind")?.("", ctx);

		expect(await read("a.txt")).toBe("v2\n");
		expect(appendedSubjects(entries)).not.toContain("(before rewind)");
		expect(navigated).toEqual([]);
	});

	it("says the code has not changed when the tree already matches the checkpoint", async () => {
		const { dir, exec, write } = await makeRepo();
		await write("a.txt", "v1\n");
		const sha = await capture(dir, exec);
		const entries = [userEntry("u1", "make v1"), checkpointEntry(sha, "u1", "make v1")];

		const { commands } = loadFactory(exec, entries);
		const { ctx, notices, selectCalls } = makeCtx(dir, entries, { select: [0, RESTORE_CODE] });
		await commands.get("rewind")?.("", ctx);

		expect(selectCalls[0]?.options).toEqual(["make v1 · No code changes"]);
		expect(selectCalls[1]?.title).toContain("The code has not changed (nothing will be restored).");
		expect(notices.at(-1)?.message).toContain("already matches");
		expect(appendedSubjects(entries)).not.toContain("(before rewind)");
	});

	it("is fail-closed: a failed safety capture aborts unless the user opts into the unsafe path", async () => {
		const { dir, exec, write, read } = await makeRepo();
		await write("a.txt", "v1\n");
		const sha = await capture(dir, exec);
		const entries = [userEntry("u1", "make v1"), checkpointEntry(sha, "u1", "make v1")];
		await write("a.txt", "v2\n");

		const { commands } = loadFactory(failOnce(exec, "write-tree"), entries);
		const declined = makeCtx(dir, entries, { select: [0, RESTORE_CODE], confirm: [false] });
		await commands.get("rewind")?.("", declined.ctx);
		expect(declined.confirmMessages[0]).toContain("UNRECOVERABLE");
		expect(await read("a.txt")).toBe("v2\n");
		expect(declined.notices.at(-1)).toMatchObject({ type: "error" });
		expect(declined.notices.at(-1)?.message).toContain("aborted");
		expect(appendedSubjects(entries)).not.toContain("(before rewind)");

		const { commands: again } = loadFactory(failOnce(exec, "write-tree"), entries);
		const accepted = makeCtx(dir, entries, { select: [0, RESTORE_CODE], confirm: [true] });
		await again.get("rewind")?.("", accepted.ctx);
		expect(await read("a.txt")).toBe("v1\n");
		expect(appendedSubjects(entries)).not.toContain("(before rewind)");
	});

	it("Restore code and conversation keeps the safety net on the branch the conversation lands on", async () => {
		const { dir, exec, write, read } = await makeRepo();
		await write("a.txt", "v1\n");
		const sha = await capture(dir, exec);
		const entries = [userEntry("u1", "make v1"), checkpointEntry(sha, "u1", "make v1"), userEntry("u2", "make v2")];
		await write("a.txt", "v2\n");

		const { commands } = loadFactory(exec, entries);
		// Row 1 = "make v1" (rows are newest first).
		const { ctx, navigated } = makeCtx(dir, entries, { select: [1, RESTORE_BOTH] });
		const oldLeaf = "u2";
		// pi moves the leaf to the parent of the user message, leaving the later entries off-branch.
		(ctx as unknown as { navigateTree: (id: string) => Promise<{ cancelled: boolean }> }).navigateTree = async (
			id: string,
		) => {
			navigated.push(id);
			entries.splice(entries.findIndex((e) => e.id === id));
			return { cancelled: false };
		};
		await commands.get("rewind")?.("", ctx);

		expect(navigated).toEqual(["u1"]);
		expect(await read("a.txt")).toBe("v1\n");
		const safety = listCheckpoints(entries).find((c) => c.subject === "(before rewind)");
		expect(safety?.turnEntryId).toBe(oldLeaf);
		expect(await restoreCheckpoint(dir, exec, safety?.sha ?? "")).toBe(true);
		expect(await read("a.txt")).toBe("v2\n");
	});

	it("Restore conversation leaves the files alone", async () => {
		const { dir, exec, write, read } = await makeRepo();
		await write("a.txt", "v1\n");
		const sha = await capture(dir, exec);
		const entries = [userEntry("u1", "make v1"), checkpointEntry(sha, "u1", "make v1")];
		await write("a.txt", "v2\n");

		const { commands } = loadFactory(exec, entries);
		const { ctx, navigated } = makeCtx(dir, entries, { select: [0, RESTORE_TALK] });
		await commands.get("rewind")?.("", ctx);

		expect(navigated).toEqual(["u1"]);
		expect(await read("a.txt")).toBe("v2\n");
		expect(appendedSubjects(entries)).not.toContain("(before rewind)");
	});
});

describe("session_before_fork", () => {
	it("restores the OLDEST checkpoint of the forked turn and takes a safety net first", async () => {
		const { dir, exec, write, read } = await makeRepo();
		await write("a.txt", "before-prompt\n");
		const older = await capture(dir, exec);
		await write("a.txt", "mid-prompt\n");
		const newer = await capture(dir, exec);
		const entries = [
			userEntry("u1", "long prompt"),
			checkpointEntry(older, "u1", "long prompt"),
			checkpointEntry(newer, "u1", "long prompt"),
		];
		await write("a.txt", "after-prompt\n");

		const { handlers } = loadFactory(exec, entries);
		const { ctx, notices, confirmMessages } = makeCtx(dir, entries, { confirm: [true] });
		await handlers.get("session_before_fork")?.(
			{ type: "session_before_fork", entryId: "u1", position: "before" },
			ctx,
		);

		expect(confirmMessages).toHaveLength(1);
		expect(confirmMessages[0]).toContain("fork point");
		expect(confirmMessages[0]).toContain("a.txt");
		expect(await read("a.txt")).toBe("before-prompt\n");
		expect(appendedSubjects(entries)).toContain("(before fork)");
		expect(notices.at(-1)?.message).toContain("restored");
	});

	it("does nothing when the user keeps the current code", async () => {
		const { dir, exec, write, read } = await makeRepo();
		await write("a.txt", "v1\n");
		const sha = await capture(dir, exec);
		const entries = [userEntry("u1", "p"), checkpointEntry(sha, "u1", "p")];
		await write("a.txt", "v2\n");

		const { handlers } = loadFactory(exec, entries);
		const { ctx } = makeCtx(dir, entries, { confirm: [false] });
		await handlers.get("session_before_fork")?.(
			{ type: "session_before_fork", entryId: "u1", position: "before" },
			ctx,
		);

		expect(await read("a.txt")).toBe("v2\n");
		expect(appendedSubjects(entries)).not.toContain("(before fork)");
	});
});

describe("message_end capture", () => {
	it("checkpoints a user message, labeled by that message even when a later one lands first", async () => {
		// pi persists a message only after extensions see its message_end, so the
		// entry appears while the capture's git calls are in flight, possibly
		// followed by a steering message.
		const { dir, exec } = await makeRepo();
		const entries: SessionEntry[] = [userEntry("u0", "previous prompt")];
		const { handlers } = loadFactory(exec, entries);
		const { ctx } = makeCtx(dir, entries);
		const prompt = userEntry("u1", "the prompt");
		const { message } = prompt as unknown as { message: unknown };

		const pending = handlers.get("message_end")?.({ type: "message_end", message }, ctx);
		entries.push(prompt, userEntry("u2", "a steer that landed later"));
		await pending;
		await waitFor(() => listCheckpoints(entries).length > 0);

		const [checkpoint] = listCheckpoints(entries);
		expect(checkpoint).toMatchObject({ turnEntryId: "u1", subject: "the prompt" });
	});

	it("does not checkpoint on turns or on other messages", async () => {
		const { dir, exec } = await makeRepo();
		let calls = 0;
		const counting: Exec = (command, args, options) => {
			calls++;
			return exec(command, args, options);
		};
		const { handlers } = loadFactory(counting, []);
		const { ctx } = makeCtx(dir, []);

		expect(handlers.has("turn_start")).toBe(false);
		await handlers.get("message_end")?.(
			{ type: "message_end", message: { role: "assistant", content: [], timestamp: Date.now() } },
			ctx,
		);
		expect(calls).toBe(0);
	});
});
