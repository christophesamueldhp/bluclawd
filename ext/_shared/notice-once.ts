import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** How the user turns on `tool`, which is off by default. */
export const turnOnHint = (tool: string) =>
	`Turn it on with "defaultTools": ["+${tool}"] in ~/.pi/agent/settings.json, or for one session with pi --tools +${tool}.`;

/**
 * Tells the user `message` once, in any session: that a tool is off by default now, though they kept something
 * only it serves (Memories, wake-ups).
 */
export function toolOffNoticeOnce(ctx: ExtensionContext, agentDir: string, key: string, message: string): void {
	if (ctx.hasUI && noticeOnce(agentDir, key)) ctx.ui.notify(message, "info");
}

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
