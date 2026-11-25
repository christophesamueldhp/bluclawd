import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const turnOnHint = (tool: string) =>
	`Turn it on with "defaultTools": ["+${tool}"] in ~/.pi/agent/settings.json, or for one session with pi --tools +${tool}.`;

export function toolOffNoticeOnce(ctx: ExtensionContext, agentDir: string, key: string, message: string): void {
	if (ctx.hasUI && recordFirstNotice(agentDir, key)) ctx.ui.notify(message, "info");
}

function recordFirstNotice(agentDir: string, key: string): boolean {
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
