import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
/** Explicit package resources supplement normal Pi discovery; its loader deduplicates paths. */
export function bundledChildExtensionArgs(): string[] {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { pi: { extensions: string[] } };
	const paths = [...new Set(manifest.pi.extensions.map((path) => realpathSync(resolve(root, path))))];
	return paths.flatMap((path) => ["--extension", path]);
}
