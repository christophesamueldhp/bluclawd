import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type SearchProvider = "exa" | "openai";
export const SEARCH_PROVIDERS: readonly SearchProvider[] = ["exa", "openai"];

export interface WebPrefs {
	provider: SearchProvider;
	/** An `openai-codex` model id; unset means the default pick. */
	openaiModel?: string;
}

const prefsPath = (agentDir: string) => join(agentDir, "bluclawd", "web.json");

function stored(agentDir: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(readFileSync(prefsPath(agentDir), "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

export function loadWebPrefs(agentDir: string): WebPrefs {
	const { provider, openaiModel } = stored(agentDir);
	return {
		provider: provider === "openai" ? "openai" : "exa",
		openaiModel: typeof openaiModel === "string" && openaiModel !== "" ? openaiModel : undefined,
	};
}

export function saveWebPrefs(agentDir: string, update: Partial<WebPrefs>): void {
	mkdirSync(join(agentDir, "bluclawd"), { recursive: true });
	writeFileSync(prefsPath(agentDir), `${JSON.stringify({ ...stored(agentDir), ...update })}\n`, "utf8");
}
