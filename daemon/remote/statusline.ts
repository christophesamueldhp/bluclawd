/**
 * What the phone's status bar shows beside a pane's report, as pistatusline shows it under pi on
 * the Mac: the git state of the session's directory, and the plan's usage limits from the cache
 * pistatusline keeps (never fetched here).
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GitInfo {
	/** The branch, or the commit when detached. */
	branch: string;
	/** Of the `origin` remote's URL, never the URL itself (it may hold credentials). */
	owner?: string;
	/** Lines added and removed against HEAD, staged or not. */
	added: number;
	removed: number;
}

/** Only these four of the cache's fields: the rest (a token's hash among them) never leave it. */
export interface UsageLimits {
	sessionUsage?: number;
	sessionResetAt?: string;
	weeklyUsage?: number;
	weeklyResetAt?: string;
}

export interface StatusLine {
	git?: GitInfo;
	limits?: UsageLimits;
}

/** Resolves git's stdout; rejects when git fails, times out or is missing. */
export type GitRun = (cwd: string, args: string[]) => Promise<string>;

const GIT_TIMEOUT_MS = 2000;
/** As pistatusline's gitCacheTtlSeconds: a phone polling the status spawns git at most this often per directory. */
const GIT_TTL_MS = 5000;
export const USAGE_CACHE = join(homedir(), ".cache", "ccstatusline", "usage.json");

/** No fsmonitor hook, external diff or textconv runs, and no index lock is taken from under a pi using git. */
export const runGit: GitRun = (cwd, args) =>
	new Promise((resolve, reject) => {
		execFile(
			"git",
			["-C", cwd, "-c", "core.fsmonitor=false", ...args],
			{ timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
			(error, stdout) => (error ? reject(error) : resolve(stdout)),
		);
	});

/** `git diff --numstat`'s totals; a binary file counts no lines. */
export function diffTotals(numstat: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of numstat.split("\n")) {
		const [a, r] = line.split("\t");
		if (!/^\d+$/.test(a ?? "") || !/^\d+$/.test(r ?? "")) continue;
		added += Number(a);
		removed += Number(r);
	}
	return { added, removed };
}

/** `owner` of git@host:owner/repo.git, https://host/owner/repo, ssh://git@host/owner/repo.git. */
export function originOwner(url: string): string | undefined {
	return /[:/]([^/:]+)\/[^/]+?(?:\.git)?\/?$/.exec(url.trim())?.[1];
}

/** Undefined outside a git repository. */
export async function gitInfo(cwd: string, run: GitRun = runGit): Promise<GitInfo | undefined> {
	let branch: string;
	try {
		branch = (await run(cwd, ["branch", "--show-current"])).trim();
	} catch {
		return undefined;
	}
	const [head, diff, origin] = await Promise.all([
		branch ||
			run(cwd, ["rev-parse", "--short", "HEAD"]).then(
				(s) => s.trim(),
				() => "",
			),
		run(cwd, ["diff", "--numstat", "--no-ext-diff", "--no-textconv", "HEAD"]).catch(() => ""),
		run(cwd, ["remote", "get-url", "origin"]).catch(() => ""),
	]);
	if (!head) return undefined;
	const owner = originOwner(origin);
	return { branch: head, ...(owner ? { owner } : {}), ...diffTotals(diff) };
}

/** gitInfo, kept per directory for a few seconds; requests meanwhile share one run. */
export function gitInfoCache(
	run: GitRun = runGit,
	now: () => number = Date.now,
): (cwd: string) => Promise<GitInfo | undefined> {
	const cache = new Map<string, { at: number; info: Promise<GitInfo | undefined> }>();
	return (cwd) => {
		const hit = cache.get(cwd);
		if (hit && now() - hit.at < GIT_TTL_MS) return hit.info;
		for (const [key, entry] of cache) if (now() - entry.at >= GIT_TTL_MS) cache.delete(key);
		const info = gitInfo(cwd, run);
		cache.set(cwd, { at: now(), info });
		return info;
	};
}

/** Undefined when the cache is missing, unreadable or has none of the four. */
export function readUsageLimits(path: string = USAGE_CACHE): UsageLimits | undefined {
	let data: unknown;
	try {
		data = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
	if (!data || typeof data !== "object") return undefined;
	const { sessionUsage, sessionResetAt, weeklyUsage, weeklyResetAt } = data as Record<string, unknown>;
	const percent = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
	const time = (value: unknown) => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined);
	const limits: UsageLimits = Object.fromEntries(
		Object.entries({
			sessionUsage: percent(sessionUsage),
			sessionResetAt: time(sessionResetAt),
			weeklyUsage: percent(weeklyUsage),
			weeklyResetAt: time(weeklyResetAt),
		}).filter(([, value]) => value !== undefined),
	);
	return Object.keys(limits).length ? limits : undefined;
}

const isNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const isTime = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value));

/** pistatusline's usage fields (its UsageData) and what each holds: only these leave its cache file. */
const PLAN_USAGE_FIELDS: Record<string, (value: unknown) => boolean> = {
	sessionUsage: isNumber,
	sessionResetAt: isTime,
	weeklyUsage: isNumber,
	weeklyResetAt: isTime,
	weeklySonnetUsage: isNumber,
	weeklySonnetResetAt: isTime,
	weeklyOpusUsage: isNumber,
	weeklyOpusResetAt: isTime,
	fableUsage: isNumber,
	fableResetAt: isTime,
	extraUsageEnabled: (value) => typeof value === "boolean",
	extraUsageLimit: isNumber,
	extraUsageUsed: isNumber,
	extraUsageUtilization: isNumber,
	extraUsageCurrency: (value) => typeof value === "string" && /^[A-Za-z]{3}$/.test(value),
};

/** The plan usage pistatusline keeps for one provider (`usage/<provider>.json` beside its settings), as
 *  its renderer takes it; undefined when the file is missing, unreadable or has none of its fields. */
export function readPlanUsage(path: string): Record<string, number | string | boolean> | undefined {
	let data: unknown;
	try {
		data = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
	if (!data || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	const usage = Object.fromEntries(
		Object.entries(PLAN_USAGE_FIELDS)
			.filter(([key, valid]) => valid(record[key]))
			.map(([key]) => [key, record[key] as number | string | boolean]),
	);
	return Object.keys(usage).length ? usage : undefined;
}

/** For a session's directory: its git state, cached, and the usage limits, read each time (the file is tiny). */
export function statusLine(
	git: (cwd: string) => Promise<GitInfo | undefined> = gitInfoCache(),
	usagePath: string = USAGE_CACHE,
): (cwd: string) => Promise<StatusLine> {
	return async (cwd) => {
		const info = await git(cwd);
		const limits = readUsageLimits(usagePath);
		return { ...(info ? { git: info } : {}), ...(limits ? { limits } : {}) };
	};
}
