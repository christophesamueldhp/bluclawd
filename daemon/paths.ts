/**
 * Where the agent view daemon lives on disk, and how its build is identified.
 * Side-effect free, so the agent-view extension imports it directly instead of
 * keeping its own copy in step with the daemon's.
 */
import { type Dirent, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
