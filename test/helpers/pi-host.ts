/**
 * The pi host the tests run against: pi-coding-agent and every `@earendil-works/*` package it resolves,
 * directly or through another. A tree that mixes versions is refused, so a pass on it cannot count as
 * compatibility evidence.
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

/** The `@earendil-works/*` dependencies of the package whose manifest is `manifest`. */
const siblingsOf = (manifest: string): string[] =>
	Object.keys(read(manifest).dependencies ?? {}).filter((dep) => dep.startsWith("@earendil-works/"));

function resolveFrom(name: string, manifest: string): string | undefined {
	try {
		return findPackageJSON(name, pathToFileURL(manifest));
	} catch {
		return undefined;
	}
}

export function piHost(hostDir: string): PiHost {
	const hostManifest = join(hostDir, "package.json");
	const { version } = read(hostManifest);
	const siblings: Record<string, string> = {};
	const mixed: string[] = [];
	const pending = siblingsOf(hostManifest).map((name) => ({ name, from: hostManifest }));
	const seen = new Set<string>();
	for (const { name, from } of pending) {
		const manifest = resolveFrom(name, from);
		if (!manifest) {
			mixed.push(`${name} missing`);
			continue;
		}
		if (seen.has(manifest)) continue;
		seen.add(manifest);
		const found = read(manifest).version;
		if (found !== version) mixed.push(`${name} ${found}`);
		else siblings[name] = found;
		pending.push(...siblingsOf(manifest).map((dep) => ({ name: dep, from: manifest })));
	}
	if (mixed.length > 0) throw new Error(`pi ${version} at ${hostDir} resolves mixed packages: ${mixed.join(", ")}`);
	return { version, siblings };
}

/** The host installed for this repository. */
export function installedPiHost(): PiHost {
	const manifest = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
	if (!manifest) throw new Error("pi-coding-agent is not installed.");
	return piHost(dirname(manifest));
}
