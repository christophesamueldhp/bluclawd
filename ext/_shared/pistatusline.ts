import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

export function pistatuslineDrawsFooter(
	pi: Pick<ExtensionAPI, "getCommands">,
	agentDir: string = getAgentDir(),
): boolean {
	if (!pi.getCommands().some((c) => c.name === "pistatusline" && c.source === "extension")) return false;
	return pistatuslineEnabled(agentDir);
}

export function pistatuslineEnabled(agentDir: string): boolean {
	try {
		const state = JSON.parse(readFileSync(join(agentDir, "pistatusline", "state.json"), "utf8"));
		return (state as { enabled?: unknown }).enabled !== false;
	} catch {
		// no state yet, so on, as pistatusline starts
		return true;
	}
}
