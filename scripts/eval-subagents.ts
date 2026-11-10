/**
 * Grading for subagent evaluations: a run is graded by the fixture's own tests and the final tree, never by what
 * its transcript claims.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** An evaluation's own spend allowance; never a limit on production runs. */
export class EvaluationBudget {
	private requests = 0;
	private tokens = 0;
	private dollars = 0;
	private maxRequests: number;
	private maxTokens: number;
	private maxDollars: number;
	constructor(maxRequests: number, maxTokens: number, maxDollars: number) {
		this.maxRequests = maxRequests;
		this.maxTokens = maxTokens;
		this.maxDollars = maxDollars;
	}
	reserve(tokens: number, dollars: number): (actualTokens: number, actualDollars: number) => void {
		if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(dollars) || dollars < 0) {
			throw new Error("Invalid budget reservation");
		}
		if (this.requests + 1 > this.maxRequests) throw new Error("Evaluation request budget exhausted");
		if (this.tokens + tokens > this.maxTokens) throw new Error("Evaluation token budget exhausted");
		if (this.dollars + dollars > this.maxDollars) throw new Error("Evaluation cost budget exhausted");
		this.requests++;
		this.tokens += tokens;
		this.dollars += dollars;
		let settled = false;
		return (actualTokens, actualDollars) => {
			if (settled) throw new Error("Reservation already settled");
			if (!Number.isFinite(actualTokens) || actualTokens < 0 || !Number.isFinite(actualDollars) || actualDollars < 0)
				throw new Error("Invalid actual usage");
			settled = true;
			this.tokens += actualTokens - tokens;
			this.dollars += actualDollars - dollars;
		};
	}
}

export function passPowerK(groups: readonly (readonly boolean[])[], k: number): number | null {
	if (!Number.isInteger(k) || k < 1 || groups.length === 0 || groups.some((g) => g.length < k)) return null;
	if (k === 1) return groups.flat().filter(Boolean).length / groups.flat().length;
	return groups.filter((group) => group.slice(0, k).every(Boolean)).length / groups.length;
}

export interface FixtureTestRun {
	readonly passed: number;
	readonly failed: number;
}

/** Runs the fixture's own tests; a crash or no tests counts as failure. */
export function runFixtureTests(cwd: string): FixtureTestRun {
	const run = spawnSync(process.execPath, ["--test", "test/"], { cwd, encoding: "utf8", timeout: 120_000 });
	const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
	const count = (label: string) => Number(output.match(new RegExp(`^ℹ ${label} (\\d+)`, "m"))?.[1] ?? 0);
	const passed = count("pass");
	const failed = count("fail");
	return { passed, failed: run.status === 0 || failed > 0 ? failed : failed + 1 };
}

function sourceFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? sourceFiles(join(dir, entry.name))
			: /\.[cm]?js$/.test(entry.name)
				? [join(dir, entry.name)]
				: [],
	);
}

/** Source files under `src/` that define each function, so a function written twice shows up. */
export function findImplementations(cwd: string, functions: readonly string[]): Record<string, string[]> {
	const files = sourceFiles(join(cwd, "src"));
	return Object.fromEntries(
		functions.map((name) => {
			const definition = new RegExp(`(function\\s+${name}\\s*\\(|(const|let|var)\\s+${name}\\s*=)`);
			return [
				name,
				files
					.filter((file) => definition.test(readFileSync(file, "utf8")))
					.map((file) => file.slice(cwd.length + 1)),
			];
		}),
	);
}

export interface FixtureGrade extends FixtureTestRun {
	/** Tests pass and every required function is implemented exactly once. */
	readonly correct: boolean;
	readonly duplicates: readonly string[];
	readonly missing: readonly string[];
	readonly changedFiles: readonly string[];
}

/** Grades a run from the final tree: the fixture's tests and its source, never the transcript. */
export function gradeFixture(cwd: string, requiredFunctions: readonly string[]): FixtureGrade {
	const tests = runFixtureTests(cwd);
	const implementations = findImplementations(cwd, requiredFunctions);
	const duplicates = requiredFunctions.filter((name) => implementations[name].length > 1);
	const missing = requiredFunctions.filter((name) => implementations[name].length === 0);
	const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, encoding: "utf8" });
	const changedFiles = (status.stdout ?? "")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => line.slice(3));
	return {
		...tests,
		correct: tests.failed === 0 && tests.passed > 0 && duplicates.length === 0 && missing.length === 0,
		duplicates,
		missing,
		changedFiles,
	};
}

/** Creates a committed fixture repository from a map of relative paths to contents. */
export function createFixture(
	files: Readonly<Record<string, string>>,
	root = mkdtempSync(join(tmpdir(), "bluclawd-eval-")),
): string {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync(
		"git",
		["-c", "user.name=Evaluation", "-c", "user.email=evaluation@example.invalid", "commit", "-qm", "fixture"],
		{
			cwd: root,
		},
	);
	return root;
}
