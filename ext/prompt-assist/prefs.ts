import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_MODEL = "opencode-go/mimo-v2.6-flash";

const prefsPath = (agentDir: string) => join(agentDir, "bluclawd", "prompt-assist.json");

export function loadAssistModel(agentDir: string): string {
	try {
		const { model } = JSON.parse(readFileSync(prefsPath(agentDir), "utf8"));
		return typeof model === "string" && /^[^/\s]+\/\S+$/.test(model) ? model : DEFAULT_MODEL;
	} catch {
		return DEFAULT_MODEL;
	}
}

export function saveAssistModel(agentDir: string, model: string): void {
	mkdirSync(join(agentDir, "bluclawd"), { recursive: true });
	writeFileSync(prefsPath(agentDir), `${JSON.stringify({ model })}\n`, "utf8");
}
