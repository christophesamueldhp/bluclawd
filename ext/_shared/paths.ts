/** pi's auth/models/debug-log path getters, which pi does not export. */

import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

export function getDebugLogPath(): string {
	return join(getAgentDir(), "pi-debug.log");
}
