import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_DIR_NAME = ".pi";
const ENV_SERVER_DIR = "PI_SERVER_DIR";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

interface PackageJson {
	version?: string;
}

function getPackageJsonPath(): string {
	let dir = __dirname;
	while (dir !== dirname(dir)) {
		const packageJsonPath = join(dir, "package.json");
		if (existsSync(packageJsonPath)) {
			return packageJsonPath;
		}
		dir = dirname(dir);
	}
	return join(__dirname, "package.json");
}

let pkg: PackageJson = {};
try {
	pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8")) as PackageJson;
} catch (e: unknown) {
	const err = e as NodeJS.ErrnoException;
	if (err.code !== "ENOENT") throw e;
}

export const VERSION: string = pkg.version || "0.0.0";

/**
 * Newest mtime (ms) of any file under `dir`, recursive. `dist/` is a shallow tree of
 * per-source-file outputs (tsgo, not a bundler) — a rebuild that only touches e.g.
 * `handler.ts` leaves `cli.js` itself untouched, so a build identifier needs the whole
 * tree's newest mtime, not just the entry file's.
 */
export function newestMtimeMs(dir: string, depth = 0): number {
	if (depth > 4) return 0; // dist/ is a few levels deep at most; this only guards a symlink loop.
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

/**
 * Build identifier for THIS running process's own installed dist/ (IMPROVEMENT-PLAN.md
 * §4.5/§5.3) — computed once at module load, since `__dirname` is fixed for the process's
 * lifetime. Echoed to clients (see ipc/protocol.ts's `ResponseBase.buildId`) so a client
 * can tell a still-running daemon apart from what's on disk right now, which a semver
 * comparison alone would miss after a version-less local rebuild.
 */
export const BUILD_ID: string = (() => {
	const newest = newestMtimeMs(__dirname);
	return newest > 0 ? new Date(newest).toISOString() : "unknown";
})();

export function getServerDir(): string {
	const envDir = process.env[ENV_SERVER_DIR];
	if (envDir) {
		return envDir;
	}

	const piDir = process.env.PI_CONFIG_DIR || join(homedir(), CONFIG_DIR_NAME);
	return join(piDir, "server");
}

export function getAuthPath(): string {
	return join(getServerDir(), "auth.json");
}

export function getMachinePath(): string {
	return join(getServerDir(), "machine.json");
}

export function getInstancesPath(): string {
	return join(getServerDir(), "instances.json");
}

export function getSocketPath(): string {
	return join(getServerDir(), "server.sock");
}
