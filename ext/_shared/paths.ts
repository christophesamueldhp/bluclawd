/**
 * pi's own auth/models/debug-log path getters aren't part of its public
 * package export, but each is a one-line join onto `getAgentDir()` (which
 * is public) against a filename pi has never changed. Vendored here instead
 * of reached into via a relative import so the layer has no import that
 * depends on `packages/coding-agent/src` existing on disk.
 */

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
