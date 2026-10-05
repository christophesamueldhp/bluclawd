/**
 * Where the agent view daemon lives on disk, and how its build is identified.
 * Side-effect free, so the agent-view extension imports it directly instead of
 * keeping its own copy in step with the daemon's.
 */
import { type Dirent, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Include the Pi installation: an unchanged daemon cannot launch children after Pi moves. */
export function daemonBuildId(dir: string, piRoot?: string): string {
	const newest = newestMtimeMs(dir);
	const source = newest > 0 ? new Date(newest).toISOString() : "unknown";
	if (!piRoot) return source;
	let root = piRoot;
	try {
		root = realpathSync(piRoot);
	} catch {
		/* A removed installation must still differ. */
	}
	return `${source}|${root}`;
}

export function getServerDir(): string {
	const envDir = process.env.PI_SERVER_DIR;
	if (envDir) {
		return envDir;
	}

	const piDir = process.env.PI_CONFIG_DIR || join(homedir(), ".pi");
	return join(piDir, "server");
}

export function getSocketPath(): string {
	return join(getServerDir(), "server.sock");
}

/**
 * Newest mtime (ms) of any file under `dir`, recursive. A change to any daemon
 * source file must change the build id, not only a change to the entry file.
 */
export function newestMtimeMs(dir: string, depth = 0): number {
	if (depth > 4) return 0; // the daemon tree is shallow; this only guards a symlink loop.
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	let newest = 0;
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			newest = Math.max(newest, newestMtimeMs(full, depth + 1));
		} else if (entry.isFile()) {
			try {
				newest = Math.max(newest, statSync(full).mtimeMs);
			} catch {
				// racing delete — skip
			}
		}
	}
	return newest;
}
