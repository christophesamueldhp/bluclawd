/**
 * The two git facts ccstatusline shows that pi's `ReadonlyFooterDataProvider`
 * does not expose: the origin remote's owner (`git-origin-owner` widget) and
 * the working-tree insertion/deletion counts (`git-changes` widget). The branch
 * itself comes from pi's provider, which also watches `.git/HEAD` for us.
 *
 * Both reads are lazy and asynchronous: a `get*()` call returns the cached
 * value immediately (null until resolved) and kicks off a refresh when stale,
 * which notifies `onChange` listeners so the footer can repaint. Every git
 * invocation is `--no-optional-locks`, so a footer refresh can never contend
 * with the user's own git commands for the index lock.
 */
import { execFile } from "node:child_process";

/** Working-tree change counts (staged + unstaged), ccstatusline `git-changes` style. */
export type GitChangeCounts = {
	insertions: number;
	deletions: number;
};

/** Cache TTL for change counts, matching ccstatusline's gitCacheTtlSeconds default. */
const CHANGES_TTL_MS = 5000;
const GIT_TIMEOUT_MS = 2000;

/** Parse `git diff --shortstat` output like ` 3 files changed, 42 insertions(+), 7 deletions(-)`. */
export function parseDiffShortStat(stat: string): GitChangeCounts {
	const insertions = /(\d+) insertions?\(\+\)/.exec(stat);
	const deletions = /(\d+) deletions?\(-\)/.exec(stat);
	return {
		insertions: insertions?.[1] ? Number.parseInt(insertions[1], 10) : 0,
		deletions: deletions?.[1] ? Number.parseInt(deletions[1], 10) : 0,
	};
}

/**
 * Extract the owner segment from a git remote URL.
 * Handles `git@host:owner/repo.git`, `https://host/owner/repo.git`, and `ssh://git@host/owner/repo`.
 */
export function parseRemoteOwner(url: string): string | null {
	let path: string;
	const scpLike = /^[^/@]+@[^/:]+:(.+)$/.exec(url);
	if (scpLike?.[1]) {
		path = scpLike[1];
	} else {
		try {
			path = new URL(url).pathname;
		} catch {
			return null;
		}
	}
	const segments = path.replace(/^\/+/, "").split("/").filter(Boolean);
	return segments.length >= 2 ? (segments[segments.length - 2] ?? null) : null;
}

function runGitCapture(cwd: string, args: string[]): Promise<string | null> {
	return new Promise((resolvePromise) => {
		execFile(
			"git",
			["--no-optional-locks", ...args],
			{ cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS },
			(error, stdout) => resolvePromise(error ? null : stdout),
		);
	});
}

export class GitInfo {
	private cwd: string;
	private changeCallbacks = new Set<() => void>();
	private cachedOriginOwner: string | null = null;
	private originOwnerRequested = false;
	private cachedChanges: GitChangeCounts | null = null;
	private changesFetchedAt = 0;
	private changesRefreshInFlight = false;
	private disposed = false;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	/** Subscribe to value changes. Returns an unsubscribe function. */
	onChange(callback: () => void): () => void {
		this.changeCallbacks.add(callback);
		return () => this.changeCallbacks.delete(callback);
	}

	/** Point at another working directory; every cached value is dropped. */
	setCwd(cwd: string): void {
		if (cwd === this.cwd) return;
		this.cwd = cwd;
		this.cachedOriginOwner = null;
		this.originOwnerRequested = false;
		this.cachedChanges = null;
		this.changesFetchedAt = 0;
	}

	dispose(): void {
		this.disposed = true;
		this.changeCallbacks.clear();
	}

	/**
	 * Owner segment of the origin remote URL, null while unresolved or without a
	 * remote. Resolved once per cwd; the remote does not change mid-session.
	 */
	getOriginOwner(): string | null {
		if (!this.originOwnerRequested) {
			this.originOwnerRequested = true;
			const cwd = this.cwd;
			void runGitCapture(cwd, ["remote", "get-url", "origin"]).then((stdout) => {
				if (this.disposed || this.cwd !== cwd || !stdout) return;
				const owner = parseRemoteOwner(stdout.trim());
				if (owner !== this.cachedOriginOwner) {
					this.cachedOriginOwner = owner;
					this.notify();
				}
			});
		}
		return this.cachedOriginOwner;
	}

	/**
	 * Staged + unstaged insertion/deletion counts, null while unresolved or
	 * outside a repo. Cached with a short TTL; a stale read kicks an async
	 * refresh that notifies on change.
	 */
	getChanges(): GitChangeCounts | null {
		if (!this.changesRefreshInFlight && Date.now() - this.changesFetchedAt > CHANGES_TTL_MS) {
			this.changesRefreshInFlight = true;
			const cwd = this.cwd;
			void Promise.all([
				runGitCapture(cwd, ["diff", "--shortstat"]),
				runGitCapture(cwd, ["diff", "--cached", "--shortstat"]),
			]).then(([unstaged, staged]) => {
				this.changesRefreshInFlight = false;
				if (this.disposed || this.cwd !== cwd) return;
				this.changesFetchedAt = Date.now();
				// Both null means git itself failed (not a repo): show nothing rather than +0,-0.
				if (unstaged === null && staged === null) {
					if (this.cachedChanges !== null) {
						this.cachedChanges = null;
						this.notify();
					}
					return;
				}
				const unstagedCounts = parseDiffShortStat(unstaged ?? "");
				const stagedCounts = parseDiffShortStat(staged ?? "");
				const next: GitChangeCounts = {
					insertions: unstagedCounts.insertions + stagedCounts.insertions,
					deletions: unstagedCounts.deletions + stagedCounts.deletions,
				};
				if (
					this.cachedChanges?.insertions !== next.insertions ||
					this.cachedChanges?.deletions !== next.deletions
				) {
					this.cachedChanges = next;
					this.notify();
				}
			});
		}
		return this.cachedChanges;
	}

	private notify(): void {
		for (const cb of this.changeCallbacks) cb();
	}
}
