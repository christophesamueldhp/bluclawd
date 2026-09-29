import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getServerDir, newestMtimeMs } from "./paths.ts";

export { getServerDir, getSocketPath } from "./paths.ts";

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
 * Build identifier for THIS running process's own daemon/ tree — computed once at module load, since `__dirname` is fixed for the process's
 * lifetime. Echoed to clients (see ipc/protocol.ts's `ResponseBase.buildId`) so a client
 * can tell a still-running daemon apart from what's on disk right now, which a semver
 * comparison alone would miss after a version-less local rebuild.
 */
export const BUILD_ID: string = (() => {
	const newest = newestMtimeMs(__dirname);
	return newest > 0 ? new Date(newest).toISOString() : "unknown";
})();

export function getMachinePath(): string {
	return join(getServerDir(), "machine.json");
}

export function getInstancesPath(): string {
	return join(getServerDir(), "instances.json");
}
