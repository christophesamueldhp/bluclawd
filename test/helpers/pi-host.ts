/**
 * The pi host the tests run against: pi-coding-agent and every `@earendil-works/*` package it resolves,
 * directly or through another. A tree that mixes versions is refused, so a pass on it cannot count as
 * compatibility evidence.
 */
import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface PiHost {
	version: string;
	siblings: Record<string, string>;
}

interface Manifest {
	version: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
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

/** The host installed for the repository at `repo`, whose own pi packages must be that host's version too. */
export function installedPiHost(repo = fileURLToPath(new URL("../..", import.meta.url))): PiHost {
	const manifest = join(repo, "package.json");
	const agent = resolveFrom("@earendil-works/pi-coding-agent", manifest);
	if (!agent) throw new Error(`pi-coding-agent is not installed in ${repo}.`);
	const host = piHost(dirname(agent));
	const mixed: string[] = [];
	for (const name of Object.keys(read(manifest).devDependencies ?? {})) {
		if (!name.startsWith("@earendil-works/")) continue;
		const found = resolveFrom(name, manifest);
		const version = found ? read(found).version : "missing";
		if (version !== host.version) mixed.push(`${name} ${version}`);
	}
	if (mixed.length > 0)
		throw new Error(`${repo} uses other packages than its pi ${host.version}: ${mixed.join(", ")}`);
	return host;
}
