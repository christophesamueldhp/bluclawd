import { join, resolve } from "node:path";

export function resolveDenyRulePath(path: string, cwd: string, home: string): string {
	if (path.startsWith("//")) return resolve(path.slice(1));
	if (path === "~") return resolve(home);
	if (path.startsWith("~/")) return resolve(join(home, path.slice(2)));
	return resolve(join(cwd, path));
}
