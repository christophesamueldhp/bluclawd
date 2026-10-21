import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_MODEL = "opencode-go/mimo-v2.6-flash";

const prefsPath = (agentDir: string) => join(agentDir, "bluclawd", "prompt-assist.json");

function preferences(agentDir: string): { model?: unknown; enabled?: unknown } {
	try {
		const parsed = JSON.parse(readFileSync(prefsPath(agentDir), "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function save(agentDir: string, update: { model?: string; enabled?: boolean }): void {
	mkdirSync(join(agentDir, "bluclawd"), { recursive: true });
	writeFileSync(prefsPath(agentDir), `${JSON.stringify({ ...preferences(agentDir), ...update })}\n`, "utf8");
}

export function loadAssistModel(agentDir: string): string {
	const { model } = preferences(agentDir);
	return typeof model === "string" && /^[^/\s]+\/\S+$/.test(model) ? model : DEFAULT_MODEL;
}

export function saveAssistModel(agentDir: string, model: string): void {
	save(agentDir, { model });
}

export function loadAssistEnabled(agentDir: string): boolean {
	return preferences(agentDir).enabled !== false;
}

export function saveAssistEnabled(agentDir: string, enabled: boolean): void {
	save(agentDir, { enabled });
}
