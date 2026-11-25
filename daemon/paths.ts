import { chmodSync, type Dirent, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function daemonBuildId(dir: string, piRoot?: string): string {
	return piRoot ? `${sourceStamp(dir)}|${piInstallStamp(piRoot)}` : sourceStamp(dir);
}

function sourceStamp(dir: string): string {
	const newest = newestMtimeMs(dir);
	return newest > 0 ? new Date(newest).toISOString() : "unknown";
}

function piInstallStamp(piRoot: string): string {
	try {
		return realpathSync(piRoot);
	} catch {
		return piRoot;
	}
}

export function defaultServerDir(): string {
	return join(homedir(), ".pi", "server");
}

export function getServerDir(): string {
	const envDir = process.env.PI_SERVER_DIR;
	if (envDir) {
		return envDir;
	}

	const configDir = process.env.PI_CONFIG_DIR;
	return configDir ? join(configDir, "server") : defaultServerDir();
}

export function ensureOwnerOnlyServerDir(dir: string = getServerDir()): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
}

export function getSocketPath(): string {
	return join(getServerDir(), "server.sock");
}

const MAX_SCAN_DEPTH = 4;

export function newestMtimeMs(dir: string, depth = 0): number {
	if (depth > MAX_SCAN_DEPTH) return 0;
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
			newest = Math.max(newest, mtimeMsOrZeroIfGone(full));
		}
	}
	return newest;
}

function mtimeMsOrZeroIfGone(file: string): number {
	try {
		return statSync(file).mtimeMs;
	} catch {
		return 0;
	}
}

export function daemonAgentDir(): string {
	const dir = process.env.PI_CODING_AGENT_DIR;
	if (!dir) return join(homedir(), ".pi", "agent");
	if (dir === "~") return homedir();
	return dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir;
}
