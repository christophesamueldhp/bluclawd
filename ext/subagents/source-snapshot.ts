import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { lstat, open, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { evaluateToolCallDeny } from "../permissions/policy.ts";
import { type IsolatedSubagentPolicySnapshot, isValidIsolatedSubagentPolicySnapshot } from "./execution-policy.ts";
import { assertSubagentPreparation, type SubagentPreparationContext, withSubagentPreparation } from "./preparation.ts";
import {
	assertPreparationCurrent,
	createSafeGitExec,
	gitFile,
	type IsolatedWorkspace,
	isWithin,
	privateDirectory,
	type RepositoryIdentity,
	resolveRepositoryIdentity,
	safeRepositoryPath,
	sourceExcludeFile,
} from "./workspace.ts";

export interface SourceSnapshot {
	snapshotId: string;
	parentSessionId: string;
	runtimeGeneration: number;
	originEntryId?: string;
	repository: RepositoryIdentity;
	sourceHead: string;
	sourceFingerprint: string;
	baseTree: string;
	indexTree: string;
	worktreeTree: string;
	repoDir: string;
}
export type SourceSnapshotRef = Pick<
	SourceSnapshot,
	"snapshotId" | "sourceHead" | "sourceFingerprint" | "baseTree" | "indexTree" | "worktreeTree"
>;
type Exec = ExtensionAPI["exec"];
interface Entry {
	path: string;
	mode: string;
	oid: string;
}
interface WorkingFile {
	path: string;
	mode: string;
	data: Buffer;
}
const MAX_FILES = 10_000;
const MAX_BYTES = 64 * 1024 * 1024;
const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function digest(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}
function safeSegment(value: string): boolean {
	return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function snapshotDirectory(agentDir: string, owner: string, id: string): string {
	if (!safeSegment(owner) || !/^src_[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid snapshot storage identity");
	return join(realpathSync(agentDir), "bluclawd", "subagents", owner, "sources", id);
}

export function readSourceSnapshot(agentDir: string, owner: string, snapshotId: string): SourceSnapshot {
	const dir = snapshotDirectory(agentDir, owner, snapshotId);
	if (realpathSync(dir) !== dir || !lstatSync(dir).isDirectory()) throw new Error("Unsafe snapshot storage");
	const file = join(dir, "snapshot.json");
	if (!lstatSync(file).isFile() || realpathSync(file) !== file) throw new Error("Symlinked snapshot storage");
	const source = JSON.parse(readFileSync(file, "utf8")) as SourceSnapshot;
	if (
		source.snapshotId !== snapshotId ||
		source.parentSessionId !== owner ||
		source.repoDir !== join(dir, "repo.git") ||
		!Number.isSafeInteger(source.runtimeGeneration) ||
		source.runtimeGeneration < 0 ||
		![source.sourceHead, source.baseTree, source.indexTree, source.worktreeTree].every(
			(value) => typeof value === "string" && HASH.test(value),
		) ||
		!/^[0-9a-f]{64}$/.test(source.sourceFingerprint) ||
		!source.repository ||
		![source.repository.cwd, source.repository.root, source.repository.commonGitDir].every(
			(value) => typeof value === "string" && isAbsolute(value),
		) ||
		!isWithin(source.repository.root, source.repository.cwd) ||
		realpathSync(source.repoDir) !== source.repoDir
	) {
		throw new Error("Invalid source snapshot manifest");
	}
	return Object.freeze({ ...source, repository: Object.freeze(source.repository) });
}

async function regularBytes(root: string, path: string, signal: AbortSignal): Promise<Buffer> {
	if (!safeRepositoryPath(path)) throw new Error("Unsupported source path");
	const target = join(root, path);
	let parent = dirname(target);
	while (isWithin(root, parent)) {
		if (!(await lstat(parent)).isDirectory() || (await realpath(parent)) !== parent)
			throw new Error("Unsupported symlink in source path");
		if (parent === root) break;
		parent = dirname(parent);
	}
	const before = await lstat(target, { bigint: true });
	if (!before.isFile() || before.size > BigInt(MAX_BYTES))
		throw new Error("Unsupported source node or snapshot byte limit");
	const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const opened = await handle.stat({ bigint: true });
		if (opened.dev !== before.dev || opened.ino !== before.ino)
			throw new Error("Source changed while opening a file");
		const data = await handle.readFile({ signal });
		const after = await handle.stat({ bigint: true });
		if (
			(await realpath(target)) !== target ||
			data.length > MAX_BYTES ||
			after.size !== before.size ||
			after.mtimeNs !== before.mtimeNs ||
			after.ctimeNs !== before.ctimeNs ||
			(await lstat(target, { bigint: true })).ino !== before.ino
		)
			throw new Error("Source changed while reading a file");
		return data;
	} finally {
		await handle.close();
	}
}

async function gitText(exec: Exec, cwd: string, args: string[], signal: AbortSignal): Promise<string> {
	const git = createSafeGitExec(exec, { cwd, root: cwd, commonGitDir: cwd });
	const result = await git("git", args, { signal });
	signal.throwIfAborted();
	if (result.code !== 0 || result.killed) throw new Error(`Source Git operation failed: ${args[0]}`);
	return result.stdout;
}
function parseEntries(text: string, staged: boolean): Entry[] {
	return text
		.split("\0")
		.filter(Boolean)
		.map((row) => {
			const match = (
				staged ? /^(\d{6}) ([0-9a-f]{40,64}) (\d)\t([\s\S]+)$/ : /^(\d{6}) blob ([0-9a-f]{40,64})\t([\s\S]+)$/
			).exec(row);
			if (!match || (staged && match[3] !== "0")) throw new Error("Unsupported source index or tree entry");
			const path = match[staged ? 4 : 3];
			if (!safeRepositoryPath(path)) throw new Error("Unsupported source path");
			return { mode: match[1], oid: match[2], path };
		});
}
function readable(policy: IsolatedSubagentPolicySnapshot, repository: RepositoryIdentity, path: string): boolean {
	const physical = join(repository.root, path);
	const logical = resolve(policy.cwd, relative(repository.cwd, physical));
	return ![physical, logical].some((file) =>
		evaluateToolCallDeny(policy.denyRules, "read", { path: file }, policy.cwd),
	);
}

async function sourceState(
	exec: Exec,
	repository: RepositoryIdentity,
	policy: IsolatedSubagentPolicySnapshot,
	temp: string,
	signal: AbortSignal,
) {
	const root = repository.root;
	const head = (await gitText(exec, root, ["rev-parse", "--verify", "HEAD"], signal)).trim();
	if (!HASH.test(head)) throw new Error("Unavailable source HEAD");
	const indexPath = (
		await gitText(exec, root, ["rev-parse", "--path-format=absolute", "--git-path", "index"], signal)
	).replace(/\n$/, "");
	let indexBytes: Buffer;
	try {
		indexBytes = await regularBytes(dirname(indexPath), relative(dirname(indexPath), indexPath), signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		indexBytes = Buffer.alloc(0);
	}
	const settings = await gitText(exec, root, ["config", "--null", "--list"], signal);
	if (/(?:core\.sparsecheckout\ntrue|extensions\.partialclone\n|remote\.[^\0]*\.promisor\ntrue)/i.test(settings))
		throw new Error("Unsupported sparse or partial source");
	if ((await gitText(exec, root, ["for-each-ref", "--format=%(refname)", "refs/replace"], signal)).trim())
		throw new Error("Unsupported source replacement refs");
	const base = parseEntries(await gitText(exec, root, ["ls-tree", "-r", "-z", "--full-tree", head], signal), false);
	const indexText = await gitText(exec, root, ["ls-files", "--stage", "--full-name", "-z"], signal);
	const index = parseEntries(indexText, true);
	const debug = await gitText(exec, root, ["ls-files", "--debug", "-z"], signal);
	let offset = 0;
	while (offset < debug.length) {
		const nul = debug.indexOf("\0", offset);
		const flags = /flags: ([0-9a-f]+)\n/.exec(debug.slice(nul + 1));
		if (nul < 0 || !flags) throw new Error("Unsupported source index flags");
		if (Number.parseInt(flags[1], 16) & 0x60008000) throw new Error("Unsupported suppressed or intent-to-add index");
		offset = nul + 1 + flags.index + flags[0].length;
	}
	const others = (
		await gitText(exec, root, ["ls-files", "--others", "--exclude-standard", "--full-name", "-z"], signal)
	)
		.split("\0")
		.filter(Boolean);
	const paths = [...new Set([...base.map((row) => row.path), ...index.map((row) => row.path), ...others])].sort();
	if (paths.length > MAX_FILES || paths.some((path) => !safeRepositoryPath(path)))
		throw new Error("Unsupported source paths or snapshot file limit");
	const input = join(temp, "paths");
	const output = join(temp, "git-data");
	await writeFile(input, paths.map((path) => `${path}\0`).join(""), { mode: 0o600 });
	const exclude = await sourceExcludeFile(exec, repository, signal);
	await gitFile(
		exec,
		root,
		["-c", `core.excludesFile=${exclude}`, "check-ignore", "--no-index", "-z", "--stdin"],
		{ input, output },
		signal,
	);
	const ignored = new Set((await readFile(output, "utf8")).split("\0").filter(Boolean));
	const eligible = paths.filter((path) => !ignored.has(path) && readable(policy, repository, path));
	await writeFile(input, eligible.map((path) => `${path}\0`).join(""), { mode: 0o600 });
	for (const view of [[], ["--cached"], [`--source=${head}`]]) {
		await gitFile(exec, root, ["check-attr", ...view, "-z", "filter", "--stdin"], { input, output }, signal);
		const attrs = (await readFile(output, "utf8")).split("\0");
		for (let i = 2; i < attrs.length; i += 3) {
			if (!["unspecified", "unset"].includes(attrs[i])) throw new Error("Unsupported active Git filter");
		}
	}
	const allowed = new Set(eligible);
	const selectedBase = base.filter((row) => allowed.has(row.path));
	const selectedIndex = index.filter((row) => allowed.has(row.path));
	if ([...selectedBase, ...selectedIndex].some((row) => !["100644", "100755"].includes(row.mode)))
		throw new Error("Unsupported symlink or submodule source");
	const work: WorkingFile[] = [];
	let bytes = 0;
	for (const path of eligible) {
		try {
			const data = await regularBytes(root, path, signal);
			bytes += data.length;
			if (bytes > MAX_BYTES) throw new Error("Snapshot exceeds byte limit");
			const node = await lstat(join(root, path));
			work.push({ path, mode: node.mode & 0o111 ? "100755" : "100644", data });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	const fingerprint = digest(
		JSON.stringify({
			head,
			index: digest(indexBytes),
			settings: digest(settings),
			indexText,
			debug,
			ignored: [...ignored].sort(),
			files: work.map((file) => [file.path, file.mode, digest(file.data)]),
		}),
	);
	return { head, fingerprint, base: selectedBase, index: selectedIndex, work };
}

async function sourceObjects(
	exec: Exec,
	root: string,
	entries: Entry[],
	temp: string,
	signal: AbortSignal,
): Promise<Map<string, Buffer>> {
	const ids = [...new Set(entries.map((entry) => entry.oid))];
	const result = new Map<string, Buffer>();
	if (!ids.length) return result;
	const input = join(temp, "object-ids");
	const output = join(temp, "objects-data");
	await writeFile(input, `${ids.join("\n")}\n`, { mode: 0o600 });
	await gitFile(exec, root, ["cat-file", "--batch-check"], { input, output }, signal);
	const metadata = (await readFile(output, "utf8")).trim().split("\n");
	let total = 0;
	for (let i = 0; i < ids.length; i++) {
		const match = /^([0-9a-f]{40,64}) blob ([0-9]+)$/.exec(metadata[i] ?? "");
		if (!match || match[1] !== ids[i]) throw new Error("Unavailable source object");
		total += Number(match[2]);
		if (!Number.isSafeInteger(total) || total > MAX_BYTES) throw new Error("Snapshot exceeds byte limit");
	}
	await gitFile(exec, root, ["cat-file", "--batch"], { input, output }, signal);
	if ((await lstat(output)).size > MAX_BYTES + ids.length * 128)
		throw new Error("Source object batch exceeds byte limit");
	const raw = await readFile(output);
	let offset = 0;
	for (const id of ids) {
		const end = raw.indexOf(10, offset);
		const match = /^([0-9a-f]{40,64}) blob ([0-9]+)$/.exec(raw.toString("ascii", offset, end));
		if (end < offset || !match || match[1] !== id) throw new Error("Invalid source object batch");
		const size = Number(match[2]);
		const data = raw.subarray(end + 1, end + 1 + size);
		if (data.length !== size || raw[end + 1 + size] !== 10) throw new Error("Truncated source object batch");
		const hash = createHash(id.length === 40 ? "sha1" : "sha256")
			.update(`blob ${size}\0`)
			.update(data)
			.digest("hex");
		if (hash !== id) throw new Error("Source object changed or is corrupt");
		result.set(id, data);
		offset = end + size + 2;
	}
	if (offset !== raw.length) throw new Error("Unexpected source object data");
	return result;
}

async function importBlobs(
	exec: Exec,
	repoDir: string,
	buffers: readonly Buffer[],
	temp: string,
	signal: AbortSignal,
): Promise<string[]> {
	if (!buffers.length) return [];
	if (buffers.reduce((sum, data) => sum + data.length, 0) > MAX_BYTES) throw new Error("Snapshot exceeds byte limit");
	const input = join(temp, "blob-import");
	const marks = join(temp, "blob-marks");
	const file = await open(input, "w", 0o600);
	try {
		for (let i = 0; i < buffers.length; i++) {
			signal.throwIfAborted();
			await file.writeFile(`blob\nmark :${i + 1}\ndata ${buffers[i].length}\n`);
			await file.writeFile(buffers[i]);
			await file.writeFile("\n");
		}
		await file.writeFile("done\n");
	} finally {
		await file.close();
	}
	await gitFile(exec, repoDir, ["fast-import", "--quiet", "--done", `--export-marks=${marks}`], { input }, signal);
	const parsed = new Map<number, string>();
	for (const row of (await readFile(marks, "utf8")).trim().split("\n")) {
		const match = /^:([0-9]+) ([0-9a-f]{40,64})$/.exec(row);
		if (!match) throw new Error("Invalid private blob marks");
		parsed.set(Number(match[1]), match[2]);
	}
	return buffers.map((_, i) => {
		const oid = parsed.get(i + 1);
		if (!oid || !HASH.test(oid)) throw new Error("Missing private blob mark");
		return oid;
	});
}

async function writeTree(
	exec: Exec,
	repoDir: string,
	entries: Entry[],
	temp: string,
	signal: AbortSignal,
): Promise<string> {
	const file = join(temp, "index-info");
	await writeFile(file, entries.map((row) => `${row.mode} ${row.oid}\t${row.path}\0`).join(""), { mode: 0o600 });
	const indexFile = join(temp, "tree-index");
	const git = createSafeGitExec(exec, { cwd: repoDir, root: repoDir, commonGitDir: repoDir });
	const command = async (args: string[]) => {
		const result = await git("env", [`GIT_INDEX_FILE=${indexFile}`, "git", ...args], { signal });
		if (result.code !== 0 || result.killed) throw new Error("Private tree operation failed");
		return result.stdout.trim();
	};
	await command(["read-tree", "--empty"]);
	await gitFile(exec, repoDir, ["update-index", "-z", "--index-info"], { input: file, indexFile }, signal);
	const tree = await command(["write-tree"]);
	if (!HASH.test(tree)) throw new Error("Invalid private snapshot tree");
	return tree;
}

export async function captureSourceSnapshot(options: {
	agentDir: string;
	parentSessionId: string;
	runtimeGeneration: number;
	originEntryId?: string;
	policy: IsolatedSubagentPolicySnapshot;
	exec: Exec;
	signal: AbortSignal;
	preparation?: SubagentPreparationContext;
	isCurrent(): boolean;
}): Promise<SourceSnapshot> {
	if (
		!isValidIsolatedSubagentPolicySnapshot(options.policy) ||
		!safeSegment(options.parentSessionId) ||
		!Number.isSafeInteger(options.runtimeGeneration) ||
		options.runtimeGeneration < 0
	)
		throw new Error("Invalid source snapshot policy or owner");
	if (options.preparation === undefined)
		return withSubagentPreparation(options, (preparation) => captureSourceSnapshot({ ...options, preparation }));
	const preparation = options.preparation;
	assertSubagentPreparation(preparation, options.parentSessionId, options.runtimeGeneration);
	const signal = AbortSignal.any([options.signal, preparation.signal]);
	const check = () => {
		assertSubagentPreparation(preparation, options.parentSessionId, options.runtimeGeneration);
		assertPreparationCurrent(signal, options.isCurrent);
	};
	check();
	const exec: Exec = async (...args) => {
		check();
		const result = await options.exec(...args);
		check();
		return result;
	};
	const repository = await resolveRepositoryIdentity(options.policy.cwd, exec, signal);
	privateDirectory(resolve(options.agentDir));
	const snapshotId = `src_${randomUUID()}`;
	const dir = snapshotDirectory(options.agentDir, options.parentSessionId, snapshotId);
	if (isWithin(repository.root, dir)) throw new Error("Source snapshot storage must be outside the source repository");
	privateDirectory(dir);
	const initial = await sourceState(exec, repository, options.policy, dir, signal);
	const repoDir = join(dir, "repo.git");
	privateDirectory(repoDir);
	await gitText(exec, repoDir, ["init", "--bare", "--quiet", "--template=", "--initial-branch=snapshot"], signal);
	const objects = await sourceObjects(exec, repository.root, [...initial.base, ...initial.index], dir, signal);
	const ids = [...objects.keys()];
	const imported = await importBlobs(
		exec,
		repoDir,
		[...objects.values(), ...initial.work.map((file) => file.data)],
		dir,
		signal,
	);
	const mapped = new Map(ids.map((id, i) => [id, imported[i]]));
	const baseTree = await writeTree(
		exec,
		repoDir,
		initial.base.map((row) => ({ ...row, oid: mapped.get(row.oid)! })),
		dir,
		signal,
	);
	const indexTree = await writeTree(
		exec,
		repoDir,
		initial.index.map((row) => ({ ...row, oid: mapped.get(row.oid)! })),
		dir,
		signal,
	);
	const working = initial.work.map((file, i) => ({
		path: file.path,
		mode: file.mode,
		oid: imported[ids.length + i],
	}));
	const worktreeTree = await writeTree(exec, repoDir, working, dir, signal);
	const final = await sourceState(exec, repository, options.policy, dir, signal);
	if (initial.fingerprint !== final.fingerprint || initial.head !== final.head)
		throw new Error("Source changed during snapshot capture; retry");
	check();
	const source: SourceSnapshot = Object.freeze({
		snapshotId,
		parentSessionId: options.parentSessionId,
		runtimeGeneration: options.runtimeGeneration,
		originEntryId: options.originEntryId,
		repository,
		sourceHead: initial.head,
		sourceFingerprint: initial.fingerprint,
		baseTree,
		indexTree,
		worktreeTree,
		repoDir,
	});
	writeFileSync(join(dir, "snapshot.json"), JSON.stringify(source), { mode: 0o600, flag: "wx" });
	return source;
}

export async function captureWorkspaceTree(options: {
	workspace: IsolatedWorkspace;
	policy: IsolatedSubagentPolicySnapshot;
	exec: Exec;
	signal: AbortSignal;
}): Promise<string> {
	if (!isValidIsolatedSubagentPolicySnapshot(options.policy)) throw new Error("Invalid workspace observation policy");
	const { workspace, policy, exec, signal } = options;
	const temp = join(dirname(workspace.root), "observations", `tree-${randomUUID()}`);
	privateDirectory(temp);
	const git = createSafeGitExec(exec, { cwd: workspace.root, root: workspace.root, commonGitDir: workspace.gitDir });
	const listed = await git("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { signal });
	if (listed.code !== 0) throw new Error("Cannot observe workspace files");
	const baseline = await git("git", ["ls-tree", "-r", "--name-only", "-z", workspace.source.worktreeTree], { signal });
	if (baseline.code !== 0) throw new Error("Cannot observe baseline workspace files");
	const paths = [...new Set((listed.stdout + baseline.stdout).split("\0").filter(Boolean))].sort();
	if (paths.length > MAX_FILES) throw new Error("Workspace exceeds file limit");
	const entries: Entry[] = [];
	const buffers: Buffer[] = [];
	let bytes = 0;
	for (const path of paths) {
		if (!safeRepositoryPath(path)) throw new Error("Unsupported workspace path");
		const logical = resolve(policy.cwd, relative(workspace.executionCwd, join(workspace.root, path)));
		if (evaluateToolCallDeny(policy.denyRules, "read", { path: logical }, policy.cwd)) continue;
		try {
			const data = await regularBytes(workspace.root, path, signal);
			bytes += data.length;
			if (bytes > MAX_BYTES) throw new Error("Workspace exceeds byte limit");
			const node = await lstat(join(workspace.root, path));
			buffers.push(data);
			entries.push({ path, oid: "", mode: node.mode & 0o111 ? "100755" : "100644" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	const imported = await importBlobs(exec, workspace.root, buffers, temp, signal);
	return writeTree(
		exec,
		workspace.root,
		entries.map((row, i) => ({ ...row, oid: imported[i] })),
		temp,
		signal,
	);
}
