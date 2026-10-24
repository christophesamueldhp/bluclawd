import { isAbsolute } from "node:path";
import { type SupportedSubagentTool, workspaceModeForTools } from "./definitions.ts";

const SNAPSHOT_BRAND = Symbol("bluclawd.subagent.isolatedPolicy");
const snapshots = new WeakSet<object>();

export interface IsolatedSubagentPolicySnapshot {
	readonly [SNAPSHOT_BRAND]: true;
	readonly cwd: string;
	readonly denyRules: readonly string[];
	readonly allowedTools: readonly SupportedSubagentTool[];
}

export function createIsolatedSubagentPolicySnapshot(options: {
	cwd: string;
	denyRules: readonly string[];
	allowedTools: readonly SupportedSubagentTool[];
}): { ok: boolean; snapshot?: IsolatedSubagentPolicySnapshot; error?: string } {
	try {
		if (!options || typeof options.cwd !== "string" || !isAbsolute(options.cwd) || options.cwd.includes("\0")) {
			throw new Error("An absolute cwd is required");
		}
		if (!Array.isArray(options.denyRules) || !options.denyRules.every((rule) => typeof rule === "string")) {
			throw new Error("Deny rules must be strings");
		}
		if (workspaceModeForTools(options.allowedTools) !== "isolated") {
			throw new Error("Isolated policy requires shell or write capabilities");
		}
		const snapshot: IsolatedSubagentPolicySnapshot = Object.freeze({
			[SNAPSHOT_BRAND]: true as const,
			cwd: options.cwd,
			denyRules: Object.freeze([...options.denyRules]),
			allowedTools: Object.freeze([...new Set(options.allowedTools)]),
		});
		snapshots.add(snapshot);
		return { ok: true, snapshot };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export function isValidIsolatedSubagentPolicySnapshot(value: unknown): value is IsolatedSubagentPolicySnapshot {
	return typeof value === "object" && value !== null && snapshots.has(value);
}
