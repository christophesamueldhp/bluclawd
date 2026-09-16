/**
 * GitHub URL handler for `webfetch`: repository, file, issue and pull request
 * URLs are answered through the `gh` CLI (and a shallow `git clone` for
 * repositories) instead of scraping github.com's HTML.
 *
 * Everything here is best effort. When `gh`/`git` are missing, unauthenticated,
 * or the API refuses, `fetchGithub` returns undefined and the caller falls back
 * to a normal page fetch. The only error it throws is an abort.
 *
 * Ref limit: in `/blob/<ref>/<path>` and `/tree/<ref>/<path>` the FIRST segment
 * is taken as the ref. A branch containing `/` (feature/x) only resolves when
 * the slash is percent-encoded (feature%2Fx); otherwise the lookup fails and the
 * caller falls back to the page fetch.
 */

import { execFile } from "node:child_process";
import {
	type Dirent,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

export type GithubTarget =
	| { kind: "repo"; owner: string; repo: string; ref?: string; path?: string }
	| { kind: "file"; owner: string; repo: string; ref: string; path: string }
	| { kind: "issue" | "pull"; owner: string; repo: string; number: number };

export type GithubRunner = (
	cmd: "gh" | "git",
	args: string[],
	opts: { cwd?: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface GithubFetchOptions {
	signal?: AbortSignal;
	allowClone: boolean;
	run?: GithubRunner;
	/** Default: join(tmpdir(), "bluclawd-github"). */
	cloneRoot?: string;
}

const GH_TIMEOUT_MS = 15_000;
const CLONE_TIMEOUT_MS = 30_000;
const MAX_CLONE_KB = 350 * 1024;
const MAX_FILE_BYTES = 1_000_000;
const MAX_README_BYTES = 20_000;
const MAX_TREE_ENTRIES = 300;
const TREE_DEPTH = 3;
const MAX_ISSUE_BYTES = 60_000;
const MAX_BODY_CHARS = 20_000;
const MAX_COMMENT_CHARS = 4_000;
const MAX_COMMENTS = 30;
const MAX_REVIEWS = 20;
const MAX_FILES = 100;

// ── URL parsing ─────────────────────────────────────────────────────────────

// Top-level github.com paths that look like /<owner>/<repo> but are not repositories.
const RESERVED_OWNERS = new Set([
	"about",
	"apps",
	"collections",
	"codespaces",
	"enterprise",
	"events",
	"explore",
	"features",
	"issues",
	"login",
	"marketplace",
	"new",
	"notifications",
	"orgs",
	"organizations",
	"pricing",
	"pulls",
	"search",
	"settings",
	"site",
	"sponsors",
	"topics",
	"trending",
	"users",
]);

const PULL_SUBPAGES = new Set(["files", "commits", "checks"]);

function validOwner(owner: string): boolean {
	return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) && !owner.includes("--");
}

function validRepo(repo: string): boolean {
	return /^[A-Za-z0-9._-]{1,100}$/.test(repo) && repo !== "." && repo !== "..";
}

function validRef(ref: string): boolean {
	// A leading "-" could read as a git option; ".." and control chars are never valid ref names.
	return (
		ref.length > 0 && ref.length <= 255 && !ref.startsWith("-") && !ref.includes("..") && !/[\0-\x20\x7f]/.test(ref)
	);
}

function validPathSegments(segments: string[]): boolean {
	return segments.every((s) => s !== "." && s !== ".." && !s.includes("\\") && !/[\0-\x1f\x7f]/.test(s));
}

/** The GitHub target a github.com URL names, or undefined for anything this module does not handle. */
export function parseGithubUrl(url: URL): GithubTarget | undefined {
	if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
	const host = url.hostname.toLowerCase();
	if (host !== "github.com" && host !== "www.github.com") return undefined;
	const segments: string[] = [];
	for (const raw of url.pathname.split("/")) {
		if (!raw) continue;
		try {
			segments.push(decodeURIComponent(raw));
		} catch {
			return undefined;
		}
	}
	if (segments.length < 2) return undefined;
	const owner = segments[0];
	const repo = segments[1].replace(/\.git$/, "");
	if (RESERVED_OWNERS.has(owner.toLowerCase()) || !validOwner(owner) || !validRepo(repo)) return undefined;
	if (segments.length === 2) return { kind: "repo", owner, repo };

	const action = segments[2];
	if (action === "issues" || action === "pull") {
		const n = segments[3];
		if (!n || !/^\d{1,9}$/.test(n) || Number(n) === 0) return undefined;
		if (action === "issues" && segments.length > 4) return undefined;
		if (action === "pull" && (segments.length > 5 || (segments.length === 5 && !PULL_SUBPAGES.has(segments[4]))))
			return undefined;
		return { kind: action === "issues" ? "issue" : "pull", owner, repo, number: Number(n) };
	}
	if (action !== "blob" && action !== "tree") return undefined;
	const ref = segments[3];
	if (!ref || !validRef(ref)) return undefined;
	const pathSegments = segments.slice(4);
	if (!validPathSegments(pathSegments)) return undefined;
	const path = pathSegments.join("/");
	if (action === "blob") return path ? { kind: "file", owner, repo, ref, path } : undefined;
	return path ? { kind: "repo", owner, repo, ref, path } : { kind: "repo", owner, repo, ref };
}

// ── process runner ──────────────────────────────────────────────────────────

const defaultRunner: GithubRunner = (cmd, args, opts) =>
	new Promise((resolve, reject) => {
		execFile(
			cmd,
			args,
			{
				cwd: opts.cwd,
				timeout: opts.timeoutMs,
				signal: opts.signal,
				maxBuffer: 20 * 1024 * 1024,
				encoding: "utf8",
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GIT_LFS_SKIP_SMUDGE: "1" },
			},
			(err, stdout, stderr) => {
				if (!err) return resolve({ code: 0, stdout, stderr });
				if (opts.signal?.aborted) return reject(opts.signal.reason ?? err);
				const e = err as NodeJS.ErrnoException & { killed?: boolean };
				if (e.code === "ENOENT") return resolve({ code: 127, stdout: "", stderr: `${cmd}: not found` });
				if (e.killed) return resolve({ code: 124, stdout, stderr: `${stderr}\n${cmd}: timed out`.trim() });
				resolve({ code: typeof e.code === "number" ? e.code : 1, stdout, stderr: stderr || e.message });
			},
		);
	});

// ── helpers ─────────────────────────────────────────────────────────────────

interface Ctx {
	run: GithubRunner;
	signal?: AbortSignal;
}

async function exec(ctx: Ctx, cmd: "gh" | "git", args: string[], timeoutMs = GH_TIMEOUT_MS, cwd?: string) {
	const result = await ctx.run(cmd, args, { cwd, timeoutMs, signal: ctx.signal });
	ctx.signal?.throwIfAborted();
	return result;
}

/** `gh api <endpoint>` parsed as JSON, or undefined on any failure. */
async function ghApi(ctx: Ctx, endpoint: string, extra: string[] = []): Promise<any> {
	const r = await exec(ctx, "gh", ["api", endpoint, ...extra]);
	if (r.code !== 0) return undefined;
	try {
		return JSON.parse(r.stdout);
	} catch {
		return undefined;
	}
}

function contentsEndpoint(owner: string, repo: string, base: string, path: string | undefined, ref?: string): string {
	const encoded = (path ?? "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
	const endpoint = `repos/${owner}/${repo}/${base}${encoded ? `/${encoded}` : ""}`;
	return ref ? `${endpoint}?ref=${encodeURIComponent(ref)}` : endpoint;
}

function capText(text: string, maxBytes: number, what: string): string {
	const buf = Buffer.from(text);
	if (buf.length <= maxBytes) return text;
	return `${buf
		.subarray(0, maxBytes)
		.toString()
		.replace(/\uFFFD$/, "")}\n\n[… ${what} truncated at ${maxBytes} bytes]`;
}

const LANGUAGES: Record<string, string> = {
	c: "c",
	cc: "cpp",
	cpp: "cpp",
	cs: "csharp",
	css: "css",
	go: "go",
	h: "c",
	hpp: "cpp",
	html: "html",
	java: "java",
	js: "javascript",
	json: "json",
	jsx: "jsx",
	kt: "kotlin",
	md: "markdown",
	mjs: "javascript",
	mts: "typescript",
	php: "php",
	py: "python",
	rb: "ruby",
	rs: "rust",
	sh: "bash",
	sql: "sql",
	swift: "swift",
	toml: "toml",
	ts: "typescript",
	tsx: "tsx",
	yaml: "yaml",
	yml: "yaml",
	zig: "zig",
};

function languageFor(path: string): string {
	const name = path.split("/").pop() ?? "";
	if (name === "Dockerfile") return "dockerfile";
	if (name === "Makefile") return "makefile";
	const dot = name.lastIndexOf(".");
	return dot > 0 ? (LANGUAGES[name.slice(dot + 1).toLowerCase()] ?? "") : "";
}

function fenced(content: string, lang: string): string {
	const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((m) => m.length));
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}${lang}\n${content.endsWith("\n") ? content : `${content}\n`}${fence}`;
}

function decodeBase64File(data: any): string | undefined {
	if (!data || Array.isArray(data) || data.type !== "file") return undefined;
	if (typeof data.size === "number" && data.size > MAX_FILE_BYTES) return undefined;
	if (data.encoding !== "base64" || typeof data.content !== "string") return undefined;
	const text = Buffer.from(data.content, "base64").toString("utf8");
	return text.includes("\0") ? undefined : text;
}

function repoHeader(t: { owner: string; repo: string; ref?: string; path?: string }): string {
	const at = [t.ref ? `ref \`${t.ref}\`` : "", t.path ? `path \`${t.path}\`` : ""].filter(Boolean).join(", ");
	return `# ${t.owner}/${t.repo}${at ? ` (${at})` : ""}\n\nhttps://github.com/${t.owner}/${t.repo}`;
}

// ── file ────────────────────────────────────────────────────────────────────

async function fetchFile(ctx: Ctx, t: Extract<GithubTarget, { kind: "file" }>) {
	const data = await ghApi(ctx, contentsEndpoint(t.owner, t.repo, "contents", t.path, t.ref));
	const text = decodeBase64File(data);
	if (text === undefined) return undefined;
	return { text: `# ${t.owner}/${t.repo}: ${t.path} (ref \`${t.ref}\`)\n\n${fenced(text, languageFor(t.path))}` };
}

// ── repository ──────────────────────────────────────────────────────────────

function isSha(ref: string | undefined): boolean {
	return !!ref && /^[0-9a-f]{40}$/i.test(ref);
}

/** Clone (or reuse a clone of) the repository; returns its dir or the reason it could not. */
async function ensureClone(
	ctx: Ctx,
	t: Extract<GithubTarget, { kind: "repo" }>,
	cloneRoot: string,
): Promise<{ dir: string } | { reason: string }> {
	if (isSha(t.ref)) return { reason: "the ref is a commit SHA, which a shallow branch clone cannot check out" };
	const dirName = `${t.owner}-${t.repo}-${(t.ref ?? "default").replace(/[^A-Za-z0-9._-]/g, "_")}`;
	const dir = join(cloneRoot, dirName);
	if (existsSync(join(dir, ".git"))) return { dir };

	const size = await exec(ctx, "gh", ["api", `repos/${t.owner}/${t.repo}`, "--jq", ".size"]);
	if (size.code === 127) return { reason: "gh is not installed, so the repository size could not be checked" };
	const kb = Number.parseInt(size.stdout.trim(), 10);
	if (size.code !== 0 || Number.isNaN(kb)) return { reason: "the repository size could not be checked with gh" };
	if (kb > MAX_CLONE_KB)
		return { reason: `the repository is ${Math.round(kb / 1024)} MB, over the 350 MB clone limit` };

	// A dir without .git is a clone that was killed part-way.
	if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	mkdirSync(cloneRoot, { recursive: true });
	const args = ["-c", "core.hooksPath=/dev/null", "clone", "--depth", "1", "--single-branch", "--no-tags"];
	if (t.ref) args.push(`--branch=${t.ref}`);
	args.push(`https://github.com/${t.owner}/${t.repo}.git`, dir);
	let clone: Awaited<ReturnType<GithubRunner>>;
	try {
		clone = await exec(ctx, "git", args, CLONE_TIMEOUT_MS);
	} catch (err) {
		rmSync(dir, { recursive: true, force: true });
		throw err;
	}
	if (clone.code === 0 && existsSync(join(dir, ".git"))) return { dir };
	rmSync(dir, { recursive: true, force: true });
	if (clone.code === 127) return { reason: "git is not installed" };
	const lastLine = clone.stderr.trim().split("\n").pop() ?? "";
	return { reason: `git clone failed${lastLine ? `: ${lastLine}` : ""}` };
}

interface TreeNode {
	name: string;
	children?: TreeNode[];
	/** Children read from disk but left out once the entry budget ran out. */
	omitted: number;
}

/**
 * The tree under `root`, `TREE_DEPTH` levels deep. Entries are admitted
 * breadth-first until `MAX_TREE_ENTRIES`, so a big subdirectory cannot push the
 * top-level files out; each directory that lost entries gets a "… N more" line.
 */
function listTree(root: string): string {
	const top: TreeNode = { name: "", children: [], omitted: 0 };
	let admitted = 0;
	let level: Array<{ node: TreeNode; dir: string }> = [{ node: top, dir: root }];
	for (let depth = 0; depth < TREE_DEPTH && level.length; depth++) {
		const next: typeof level = [];
		for (const { node, dir } of level) {
			let entries: Dirent[];
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			entries = entries
				.filter((e) => e.name !== ".git")
				.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
			node.children = [];
			for (const e of entries) {
				if (admitted >= MAX_TREE_ENTRIES) {
					node.omitted++;
					continue;
				}
				admitted++;
				// isDirectory() does not follow symlinks, so a link out of the clone is listed, never walked.
				const child: TreeNode = { name: e.isDirectory() ? `${e.name}/` : e.name, omitted: 0 };
				node.children.push(child);
				if (e.isDirectory()) next.push({ node: child, dir: join(dir, e.name) });
			}
		}
		level = next;
	}
	const lines: string[] = [];
	const render = (node: TreeNode, depth: number) => {
		for (const child of node.children ?? []) {
			lines.push(`${"  ".repeat(depth)}${child.name}`);
			render(child, depth + 1);
		}
		if (node.omitted) lines.push(`${"  ".repeat(depth)}… ${node.omitted} more`);
	};
	render(top, 0);
	return lines.join("\n");
}

function readmeIn(dir: string): string | undefined {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return undefined;
	}
	const name = names.find((n) => n.toLowerCase() === "readme.md");
	if (!name) return undefined;
	const file = join(dir, name);
	// Regular files only: a README symlink could point anywhere on this machine.
	if (!lstatSync(file).isFile()) return undefined;
	return capText(readFileSync(file, "utf8"), MAX_README_BYTES, "README");
}

function renderClone(t: Extract<GithubTarget, { kind: "repo" }>, dir: string) {
	let base = dir;
	if (t.path) {
		base = join(dir, ...t.path.split("/"));
		let real: string;
		try {
			real = realpathSync(base);
		} catch {
			return undefined;
		}
		const rel = relative(realpathSync(dir), real);
		if (rel.startsWith("..") || rel.startsWith(sep) || !lstatSync(real).isDirectory()) return undefined;
		base = real;
	}
	const parts = [repoHeader(t), `## Files${t.path ? ` in ${t.path}` : ""}\n\n\`\`\`\n${listTree(base)}\n\`\`\``];
	const readme = readmeIn(base);
	if (readme !== undefined) parts.push(`## README.md\n\n${readme}`);
	return {
		text: parts.join("\n\n"),
		note: `[webfetch: repository cloned to ${dir} — use read/grep/find there]`,
	};
}

async function renderViaApi(ctx: Ctx, t: Extract<GithubTarget, { kind: "repo" }>, reason: string) {
	const listing = await ghApi(ctx, contentsEndpoint(t.owner, t.repo, "contents", t.path, t.ref));
	if (listing === undefined) return undefined;
	const note = `[webfetch: repository not cloned (${reason}); listing from the GitHub API]`;
	if (!Array.isArray(listing)) {
		// A /tree/ URL that points at a file.
		const text = decodeBase64File(listing);
		if (text === undefined || !t.path) return undefined;
		return { text: `${repoHeader(t)}\n\n${fenced(text, languageFor(t.path))}`, note };
	}
	const entries = [...listing].sort(
		(a, b) => Number(b.type === "dir") - Number(a.type === "dir") || String(a.name).localeCompare(String(b.name)),
	);
	const lines = entries.slice(0, MAX_TREE_ENTRIES).map((e) => `${e.name}${e.type === "dir" ? "/" : ""}`);
	if (entries.length > lines.length) lines.push(`… ${entries.length - lines.length} more`);
	const parts = [repoHeader(t), `## Files${t.path ? ` in ${t.path}` : ""}\n\n\`\`\`\n${lines.join("\n")}\n\`\`\``];
	const readme = decodeBase64File(await ghApi(ctx, contentsEndpoint(t.owner, t.repo, "readme", t.path, t.ref)));
	if (readme !== undefined) parts.push(`## README\n\n${capText(readme, MAX_README_BYTES, "README")}`);
	return { text: parts.join("\n\n"), note };
}

async function fetchRepo(ctx: Ctx, t: Extract<GithubTarget, { kind: "repo" }>, opts: GithubFetchOptions) {
	let reason = "cloning is not allowed here";
	if (opts.allowClone) {
		const clone = await ensureClone(ctx, t, opts.cloneRoot ?? join(tmpdir(), "bluclawd-github"));
		if ("dir" in clone) {
			const rendered = renderClone(t, clone.dir);
			if (rendered) return rendered;
			reason = `path ${t.path} is not a directory in the clone`;
		} else {
			reason = clone.reason;
		}
	}
	return renderViaApi(ctx, t, reason);
}

// ── issues and pull requests ────────────────────────────────────────────────

const ISSUE_FIELDS = "title,state,author,body,comments,labels,createdAt";
const PULL_FIELDS =
	"title,state,author,body,comments,reviews,files,additions,deletions,headRefName,baseRefName,statusCheckRollup";

function login(author: any): string {
	return typeof author?.login === "string" ? `@${author.login}` : "unknown";
}

function checksSummary(rollup: any): string | undefined {
	if (!Array.isArray(rollup) || rollup.length === 0) return undefined;
	const counts = new Map<string, number>();
	const notPassing: string[] = [];
	for (const c of rollup) {
		// CheckRun: status + conclusion; StatusContext: state.
		const result = String(c?.conclusion || c?.state || c?.status || "unknown").toUpperCase();
		counts.set(result, (counts.get(result) ?? 0) + 1);
		if (!["SUCCESS", "NEUTRAL", "SKIPPED"].includes(result))
			notPassing.push(`- ${c?.name ?? c?.context ?? "?"}: ${result}`);
	}
	const line = [...counts].map(([k, n]) => `${n} ${k.toLowerCase()}`).join(", ");
	return [`## Checks\n\n${rollup.length} checks: ${line}`, ...notPassing.slice(0, 30)].join("\n");
}

function renderIssueOrPull(t: Extract<GithubTarget, { kind: "issue" | "pull" }>, v: any): string {
	const sections: string[] = [];
	const label = t.kind === "pull" ? "Pull request" : "Issue";
	const meta = [`State: ${v.state ?? "unknown"}`, `Author: ${login(v.author)}`];
	if (v.createdAt) meta.push(`Created: ${v.createdAt}`);
	if (t.kind === "pull") {
		meta.push(`Branch: ${v.headRefName ?? "?"} → ${v.baseRefName ?? "?"}`);
		meta.push(`Changes: +${v.additions ?? 0} −${v.deletions ?? 0}`);
	}
	if (Array.isArray(v.labels) && v.labels.length) meta.push(`Labels: ${v.labels.map((l: any) => l?.name).join(", ")}`);
	sections.push(
		`# ${label} #${t.number}: ${v.title ?? ""}\n\nhttps://github.com/${t.owner}/${t.repo}/${t.kind === "pull" ? "pull" : "issues"}/${t.number}\n\n${meta.join("\n")}`,
	);
	const body = typeof v.body === "string" ? v.body.trim() : "";
	sections.push(`## Description\n\n${body ? capText(body, MAX_BODY_CHARS, "description") : "_No description._"}`);

	if (t.kind === "pull") {
		const checks = checksSummary(v.statusCheckRollup);
		if (checks) sections.push(checks);
		if (Array.isArray(v.files) && v.files.length) {
			const lines = v.files
				.slice(0, MAX_FILES)
				.map((f: any) => `- ${f?.path} (+${f?.additions ?? 0} −${f?.deletions ?? 0})`);
			if (v.files.length > MAX_FILES) lines.push(`… ${v.files.length - MAX_FILES} more`);
			sections.push(`## Changed files (${v.files.length})\n\n${lines.join("\n")}`);
		}
		const reviews = Array.isArray(v.reviews) ? v.reviews : [];
		if (reviews.length) {
			const lines = reviews.slice(0, MAX_REVIEWS).map((r: any) => {
				const text =
					typeof r?.body === "string" && r.body.trim()
						? `\n\n${capText(r.body.trim(), MAX_COMMENT_CHARS, "review")}`
						: "";
				return `### ${login(r?.author)}: ${r?.state ?? ""}${r?.submittedAt ? ` (${r.submittedAt})` : ""}${text}`;
			});
			if (reviews.length > MAX_REVIEWS) lines.push(`… ${reviews.length - MAX_REVIEWS} more`);
			sections.push(`## Reviews (${reviews.length})\n\n${lines.join("\n\n")}`);
		}
	}

	const comments = Array.isArray(v.comments) ? v.comments : [];
	if (comments.length) {
		const lines = comments.slice(0, MAX_COMMENTS).map((c: any) => {
			const text = typeof c?.body === "string" ? capText(c.body.trim(), MAX_COMMENT_CHARS, "comment") : "";
			return `### ${login(c?.author)}${c?.createdAt ? ` (${c.createdAt})` : ""}\n\n${text}`;
		});
		if (comments.length > MAX_COMMENTS) lines.push(`… ${comments.length - MAX_COMMENTS} more`);
		sections.push(`## Comments (${comments.length})\n\n${lines.join("\n\n")}`);
	}

	// Sections are in priority order: once the budget is spent the rest are dropped.
	let out = "";
	for (const section of sections) {
		const next = out ? `${out}\n\n${section}` : section;
		if (Buffer.byteLength(next) <= MAX_ISSUE_BYTES) {
			out = next;
			continue;
		}
		const room = MAX_ISSUE_BYTES - Buffer.byteLength(out) - 2;
		if (room > 500)
			out = `${out}\n\n${Buffer.from(section)
				.subarray(0, room)
				.toString()
				.replace(/\uFFFD$/, "")}`;
		out += `\n\n[… truncated at ${MAX_ISSUE_BYTES} bytes]`;
		break;
	}
	return out;
}

async function fetchIssueOrPull(ctx: Ctx, t: Extract<GithubTarget, { kind: "issue" | "pull" }>) {
	const cmd = t.kind === "pull" ? "pr" : "issue";
	const fields = t.kind === "pull" ? PULL_FIELDS : ISSUE_FIELDS;
	const r = await exec(ctx, "gh", [cmd, "view", String(t.number), "-R", `${t.owner}/${t.repo}`, "--json", fields]);
	if (r.code !== 0) return undefined;
	let view: any;
	try {
		view = JSON.parse(r.stdout);
	} catch {
		return undefined;
	}
	return { text: renderIssueOrPull(t, view) };
}

// ── entry point ─────────────────────────────────────────────────────────────

/**
 * A markdown text for the target, or undefined to let the caller fall back to a
 * normal page fetch (gh/git missing, API error, unsupported). Never throws for
 * "not available" cases; throws only on abort.
 */
export async function fetchGithub(
	target: GithubTarget,
	opts: GithubFetchOptions,
): Promise<{ text: string; note?: string } | undefined> {
	opts.signal?.throwIfAborted();
	const ctx: Ctx = { run: opts.run ?? defaultRunner, signal: opts.signal };
	switch (target.kind) {
		case "file":
			return fetchFile(ctx, target);
		case "repo":
			return fetchRepo(ctx, target, opts);
		default:
			return fetchIssueOrPull(ctx, target);
	}
}
