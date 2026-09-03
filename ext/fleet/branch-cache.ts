import { execFile } from "node:child_process";

const GIT_TIMEOUT_MS = 3000;

/**
 * The current git branch per working directory, for the roster's `time · branch · N messages`
 * line. Resolved once per cwd, asynchronously, so render never blocks on git; `onChange` fires
 * when a lookup lands so the view can repaint. A non-repo cwd caches as "" (no branch shown).
 */
export class BranchCache {
	private readonly branches = new Map<string, string>();
	private readonly inFlight = new Set<string>();
	private readonly onChange: () => void;
	private readonly lookup: (cwd: string) => Promise<string>;

	constructor(onChange: () => void, lookup: (cwd: string) => Promise<string> = gitBranch) {
		this.onChange = onChange;
		this.lookup = lookup;
	}

	/** The cached branch, or undefined while (or before) the lookup runs — which it starts. */
	get(cwd: string): string | undefined {
		const cached = this.branches.get(cwd);
		if (cached !== undefined) return cached || undefined;
		if (!this.inFlight.has(cwd)) {
			this.inFlight.add(cwd);
			void this.lookup(cwd).then((branch) => {
				this.inFlight.delete(cwd);
				this.branches.set(cwd, branch);
				this.onChange();
			});
		}
		return undefined;
	}
}

function gitBranch(cwd: string): Promise<string> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["--no-optional-locks", "rev-parse", "--abbrev-ref", "HEAD"],
			{ cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS },
			(error, stdout) => resolve(error ? "" : stdout.trim()),
		);
	});
}
