import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Whether pistatusline draws this pi's footer: its extension is loaded and its state does not turn it off.
 * It then draws each multi-line status as a block below its row of chips; pi's own footer flattens one.
 */
export function pistatuslineDrawsFooter(
	pi: Pick<ExtensionAPI, "getCommands">,
	agentDir: string = getAgentDir(),
): boolean {
	if (!pi.getCommands().some((c) => c.name === "pistatusline" && c.source === "extension")) return false;
	try {
		const state = JSON.parse(readFileSync(join(agentDir, "pistatusline", "state.json"), "utf8"));
		return (state as { enabled?: unknown }).enabled !== false;
	} catch {
		// no state yet: on, as pistatusline starts
		return true;
	}
}
