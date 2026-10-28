import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readSourceSnapshot, type SourceSnapshot, type SourceSnapshotRef } from "./source-snapshot.ts";

export interface RepositoryIdentity {
	cwd: string;
	root: string;
	commonGitDir: string;
}

export interface IsolatedWorkspace {
	runId: string;
	root: string;
	gitDir: string;
	scratchDir: string;
	executionCwd: string;
	source: SourceSnapshotRef;
}

type Exec = ExtensionAPI["exec"];
type ExecOptions = Parameters<Exec>[2];

export function isWithin(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function assertPreparationCurrent(signal: AbortSignal, isCurrent: () => boolean): void {
	signal.throwIfAborted();
	let current = false;
	try {
		current = isCurrent();
	} catch {}
	if (!current) throw new Error("Parent session owner changed during preparation");
}

export function privateDirectory(path: string): void {
	const absolute = resolve(path);
	const parent = dirname(absolute);
	if (parent !== absolute && !isAbsolute(path)) throw new Error("Private storage path must be absolute");
	if (parent !== absolute) {
		try {
			if (!lstatSync(parent).isDirectory() || realpathSync(parent) !== parent)
				throw new Error("Unsafe storage parent");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			privateDirectory(parent);
		}
	}
	try {
		mkdirSync(absolute, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	if (!lstatSync(absolute).isDirectory() || realpathSync(absolute) !== absolute)
		throw new Error("Symlinked private storage");
}

function environment(globalConfig = false): string[] {
	return [
		"-i",
		"PATH=/usr/bin:/bin:/usr/sbin:/sbin",
		"LC_ALL=C",
		`HOME=${globalConfig ? homedir() : "/dev/null"}`,
		...(globalConfig
			? ["XDG_CONFIG_HOME", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]
					.filter((key) => process.env[key] !== undefined)
					.map((key) => `${key}=${process.env[key]}`)
			: ["GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_SYSTEM=/dev/null", "GIT_CONFIG_GLOBAL=/dev/null"]),
		"GIT_OPTIONAL_LOCKS=0",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_PAGER=cat",
		"GIT_NO_LAZY_FETCH=1",
		"GIT_NO_REPLACE_OBJECTS=1",
	];
}

const SAFE_GIT_OPTIONS = [
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.pager=cat",
	"-c",
	"diff.external=",
	"-c",
	"core.autocrlf=false",
	"-c",
	"commit.gpgsign=false",
	"-c",
	"tag.gpgsign=false",
	"-c",
	"protocol.allow=never",
];

async function rawGit(
	exec: Exec,
	cwd: string,
	args: string[],
	options?: ExecOptions,
	assignments: string[] = [],
	globalConfig = false,
) {
	return exec(
		"/usr/bin/env",
		[...environment(globalConfig), ...assignments, "/usr/bin/git", ...SAFE_GIT_OPTIONS, ...args],
		{
			...options,
			cwd,
			timeout: Math.min(options?.timeout ?? 30_000, 30_000),
		},
	);
}

export async function resolveRepositoryIdentity(
	cwd: string,
	exec: Exec,
	signal?: AbortSignal,
): Promise<RepositoryIdentity> {
	const canonical = await realpath(cwd);
	const query = async (arg: string) => {
		const result = await rawGit(exec, canonical, ["rev-parse", "--path-format=absolute", arg], { signal });
		if (result.code !== 0 || result.killed) throw new Error("Source is not an available Git working tree");
		return realpath(result.stdout.replace(/\n$/, ""));
	};
	const root = await query("--show-toplevel");
	const commonGitDir = await query("--git-common-dir");
	if (!isWithin(root, canonical)) throw new Error("Git source cwd redirects outside the selected repository");
	return Object.freeze({ cwd: canonical, root, commonGitDir });
}

export function createSafeGitExec(exec: Exec, repository: RepositoryIdentity): Exec {
	return async (command, input, options) => {
		const args = [...input];
		const assignments: string[] = [];
		if (command === "env") {
			while (args[0] !== "git" && args.length) {
				const item = args.shift()!;
				if (!/^(GIT_INDEX_FILE|GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL))=/.test(item) || item.includes("\0")) {
					throw new Error("Unsafe Git environment assignment");
				}
				assignments.push(item);
			}
			if (args.shift() !== "git") throw new Error("Unsafe Git command");
		} else if (command !== "git") throw new Error("Only trusted Git commands are supported");
		if (!args[0] || args[0].startsWith("-") || args.some((arg) => arg.includes("\0")))
			throw new Error("Unsafe Git arguments");
		const cwd = await realpath(options?.cwd ?? repository.cwd);
		if (!isWithin(repository.root, cwd)) throw new Error("Git cwd is outside the repository");
		if (["add", "read-tree", "checkout", "reset"].includes(args[0])) {
			const filters = await rawGit(exec, cwd, ["config", "--get-regexp", "^filter\\."], options);
			if (filters.code === 0 && filters.stdout) throw new Error("Unsupported Git filter configuration");
		}
		if (["diff", "show"].includes(args[0])) args.splice(1, 0, "--no-ext-diff", "--no-textconv");
		return rawGit(exec, cwd, args, options, assignments);
	};
}

// Binary and NUL-delimited Git data must not round-trip through exec's UTF-8 stdout.
export async function gitFile(
	exec: Exec,
	cwd: string,
	args: string[],
	files: { input?: string; output?: string; indexFile?: string },
	signal: AbortSignal,
): Promise<void> {
	signal.throwIfAborted();
	const result = await exec(
		"/usr/bin/env",
		[
			...environment(args[0] === "check-attr"),
			...(files.indexFile ? [`GIT_INDEX_FILE=${files.indexFile}`] : []),
			"/bin/sh",
			"-c",
			'input=$1; output=$2; shift 2; if [ -n "$input" ]; then exec < "$input"; fi; if [ -n "$output" ]; then exec > "$output"; fi; exec "$@"',
			"git-data",
			files.input ?? "",
			files.output ?? "",
			"/usr/bin/git",
			...SAFE_GIT_OPTIONS,
			...args,
		],
		{ cwd, signal, timeout: 30_000 },
	);
	signal.throwIfAborted();
	if ((result.code !== 0 && !(args.includes("check-ignore") && result.code === 1)) || result.killed)
		throw new Error("Git data operation failed");
}

export async function sourceExcludeFile(
	exec: Exec,
	repository: RepositoryIdentity,
	signal: AbortSignal,
): Promise<string> {
	const result = await rawGit(
		exec,
		repository.cwd,
		["config", "--path", "--get", "core.excludesFile"],
		{ signal },
		[],
		true,
	);
	if (result.code !== 0 && result.code !== 1) throw new Error("Cannot resolve source ignore configuration");
	const configured = result.stdout.replace(/\n$/, "");
	return configured
		? resolve(repository.root, configured)
		: join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "git", "ignore");
}

async function rejectObjectLinks(path: string): Promise<void> {
	const node = await lstat(path);
	if (node.isDirectory()) {
		for (const name of await readdir(path)) await rejectObjectLinks(join(path, name));
	} else if (!node.isFile()) throw new Error("Unsafe private Git object storage");
}

export async function createIsolatedWorkspace(options: {
	runId: string;
	runDir: string;
	source: SourceSnapshot;
	exec: Exec;
	signal: AbortSignal;
	isCurrent(): boolean;
}): Promise<IsolatedWorkspace> {
	const { source, signal, isCurrent } = options;
	assertPreparationCurrent(signal, isCurrent);
	const agentDir = resolve(source.repoDir, "../../../../../..");
	const pinned = readSourceSnapshot(agentDir, source.parentSessionId, source.snapshotId);
	if (JSON.stringify(pinned) !== JSON.stringify(source)) throw new Error("Source snapshot identity changed");
	if (!/^sub_[0-9a-f-]{36}$/.test(options.runId)) throw new Error("Invalid workspace run id");
	const expected = join(resolve(source.repoDir, "../../.."), options.runId);
	if (resolve(options.runDir) !== expected) throw new Error("Workspace directory does not match runtime storage");
	privateDirectory(expected);
	const root = join(expected, "workspace");
	await mkdir(root, { mode: 0o700 });
	assertPreparationCurrent(signal, isCurrent);
	const scratchDir = await mkdtemp(
		join(process.platform === "darwin" ? "/private/tmp" : await realpath(tmpdir()), "bcs-"),
	);
	const sourceRef: SourceSnapshotRef = {
		snapshotId: source.snapshotId,
		sourceHead: source.sourceHead,
		sourceFingerprint: source.sourceFingerprint,
		baseTree: source.baseTree,
		indexTree: source.indexTree,
		worktreeTree: source.worktreeTree,
	};
	const workspace: IsolatedWorkspace = {
		runId: options.runId,
		root,
		gitDir: join(root, ".git"),
		scratchDir,
		executionCwd: join(root, relative(source.repository.root, source.repository.cwd)),
		source: sourceRef,
	};
	writeFileSync(join(expected, "workspace.json"), JSON.stringify(workspace), { mode: 0o600, flag: "wx" });
	assertPreparationCurrent(signal, isCurrent);
	const exec = options.exec;
	const git = createSafeGitExec(exec, { cwd: root, root, commonGitDir: workspace.gitDir });
	const checked = async (args: string[]) => {
		assertPreparationCurrent(signal, isCurrent);
		const result = await git("git", args, { signal });
		assertPreparationCurrent(signal, isCurrent);
		if (result.code !== 0 || result.killed) throw new Error("Workspace Git preparation failed");
		return result.stdout.trim();
	};
	await checked(["init", "--quiet", "--template=", "--initial-branch=snapshot"]);
	await rejectObjectLinks(join(source.repoDir, "objects"));
	await cp(join(source.repoDir, "objects"), join(workspace.gitDir, "objects"), { recursive: true, force: false });
	assertPreparationCurrent(signal, isCurrent);
	const commit = await git(
		"env",
		[
			"GIT_AUTHOR_NAME=bluclawd-snapshot",
			"GIT_AUTHOR_EMAIL=snapshot@bluclawd.local",
			"GIT_COMMITTER_NAME=bluclawd-snapshot",
			"GIT_COMMITTER_EMAIL=snapshot@bluclawd.local",
			"git",
			"commit-tree",
			source.baseTree,
			"-m",
			"Pinned filtered source",
		],
		{ signal },
	);
	assertPreparationCurrent(signal, isCurrent);
	if (commit.code !== 0) throw new Error("Cannot create runtime snapshot commit");
	await checked(["update-ref", "refs/heads/snapshot", commit.stdout.trim()]);
	await checked(["read-tree", source.indexTree]);
	const listing = await checked(["ls-tree", "-r", "-z", source.worktreeTree]);
	for (const row of listing.split("\0").filter(Boolean)) {
		const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(row);
		if (!match || !safeRepositoryPath(match[3])) throw new Error("Unsupported snapshot tree entry");
		const target = join(root, match[3]);
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		await gitFile(exec, root, ["cat-file", "blob", match[2]], { output: target }, signal);
		await chmod(target, match[1] === "100755" ? 0o700 : 0o600);
		assertPreparationCurrent(signal, isCurrent);
	}
	await mkdir(workspace.executionCwd, { recursive: true, mode: 0o700 });
	await mkdir(join(scratchDir, "home"), { mode: 0o700 });
	await mkdir(join(scratchDir, "tmp"), { mode: 0o700 });
	assertPreparationCurrent(signal, isCurrent);
	return Object.freeze({ ...workspace, source: Object.freeze(sourceRef) });
}

export function safeRepositoryPath(path: string): boolean {
	return (
		path.length > 0 &&
		!isAbsolute(path) &&
		!path.includes("\0") &&
		!path.includes("\\") &&
		!path.includes("\ufffd") &&
		path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git")
	);
}
