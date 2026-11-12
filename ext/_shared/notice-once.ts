import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Whether the user has yet to be given the notice `key`, in any session: true once, and recorded then, in
 * `bluclawd/notices.json` under the agent directory.
 */
export function noticeOnce(agentDir: string, key: string): boolean {
	const path = join(agentDir, "bluclawd", "notices.json");
	let given: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) given = parsed;
	} catch {}
	if (given[key] === true) return false;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ ...given, [key]: true })}\n`, "utf8");
	return true;
}
