/**
 * The pi host the tests run against: pi-coding-agent and the `@earendil-works/*` siblings it resolves from its
 * own location. A tree that mixes versions is refused, so a pass on it cannot count as compatibility evidence.
 */
import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export interface PiHost {
	version: string;
	siblings: Record<string, string>;
}

interface Manifest {
	version: string;
	dependencies?: Record<string, string>;
}

const read = (path: string): Manifest => JSON.parse(readFileSync(path, "utf8")) as Manifest;

export function piHost(hostDir: string): PiHost {
	const hostManifest = join(hostDir, "package.json");
	const { version, dependencies = {} } = read(hostManifest);
	const siblings: Record<string, string> = {};
	const mixed: string[] = [];
	for (const name of Object.keys(dependencies).filter((dep) => dep.startsWith("@earendil-works/"))) {
		let manifest: string | undefined;
		try {
			manifest = findPackageJSON(name, pathToFileURL(hostManifest));
		} catch {
			// unresolvable: reported below
		}
		if (!manifest) {
			mixed.push(`${name} missing`);
			continue;
		}
		siblings[name] = read(manifest).version;
		if (siblings[name] !== version) mixed.push(`${name} ${siblings[name]}`);
	}
	if (mixed.length > 0) throw new Error(`pi ${version} at ${hostDir} resolves mixed packages: ${mixed.join(", ")}`);
	return { version, siblings };
}

/** The host installed for this repository. */
export const PI_HOST = piHost(dirname(findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url) as string));
