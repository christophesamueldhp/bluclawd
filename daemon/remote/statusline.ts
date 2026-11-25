import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

export interface GitInfo {
	branch: string;
	owner?: string;
	added: number;
	removed: number;
}

export interface StatusLine {
	git?: GitInfo;
}

export type GitRun = (cwd: string, args: string[]) => Promise<string>;

const GIT_TIMEOUT_MS = 2000;
const GIT_TTL_MS = 5000;

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

export function originOwner(url: string): string | undefined {
	return /[:/]([^/:]+)\/[^/]+?(?:\.git)?\/?$/.exec(url.trim())?.[1];
}

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

const isNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const isTime = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value));

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

export function statusLine(
	git: (cwd: string) => Promise<GitInfo | undefined> = gitInfoCache(),
): (cwd: string) => Promise<StatusLine> {
	return async (cwd) => {
		const info = await git(cwd);
		return info ? { git: info } : {};
	};
}
