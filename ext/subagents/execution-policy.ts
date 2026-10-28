import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type SandboxRuntimeConfig, SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";
import { pathRule } from "../permissions/rules.ts";
import { type SupportedSubagentTool, workspaceModeForTools } from "./definitions.ts";
import { type IsolatedWorkspace, isWithin } from "./workspace.ts";

const SNAPSHOT_BRAND = Symbol("bluclawd.subagent.isolatedPolicy");
const snapshots = new WeakSet<object>();
const REQUIRED_MACH_LOOKUP_DENIALS = ["com.apple.securityd.xpc", "com.apple.SecurityServer"] as const;

// Schema preflight only; native enforcement is verified separately.
export function assertNativeMachLookupDenialSupport(): void {
	try {
		const parsed = SandboxRuntimeConfigSchema.safeParse({
			network: {
				allowedDomains: [],
				deniedDomains: [],
				denyMachLookup: [...REQUIRED_MACH_LOOKUP_DENIALS],
			},
			filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
		});
		const names = parsed.success ? parsed.data.network.denyMachLookup : undefined;
		if (
			Array.isArray(names) &&
			names.length === REQUIRED_MACH_LOOKUP_DENIALS.length &&
			REQUIRED_MACH_LOOKUP_DENIALS.every((name, index) => names[index] === name)
		)
			return;
	} catch {}
	throw new Error("Isolated subagents unavailable: sandbox runtime lacks required Mach-lookup denial support.");
}

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

export function buildExecutionSandboxConfig(
	policy: IsolatedSubagentPolicySnapshot,
	workspace: IsolatedWorkspace,
	runtimeReadPaths: readonly string[],
): SandboxRuntimeConfig {
	if (!isValidIsolatedSubagentPolicySnapshot(policy)) throw new Error("Invalid isolated execution policy");
	assertNativeMachLookupDenialSupport();
	const canonical = (path: string) => {
		if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") || realpathSync(path) !== path)
			throw new Error("Unsafe execution sandbox path");
	};
	for (const path of [workspace.root, workspace.gitDir, workspace.scratchDir, workspace.executionCwd]) {
		canonical(path);
		if (!lstatSync(path).isDirectory()) throw new Error("Unsafe execution workspace directory");
	}
	if (
		workspace.gitDir !== join(workspace.root, ".git") ||
		!isWithin(workspace.root, workspace.executionCwd) ||
		isWithin(workspace.root, workspace.scratchDir) ||
		isWithin(workspace.scratchDir, workspace.root) ||
		isWithin(policy.cwd, workspace.root) ||
		isWithin(workspace.root, policy.cwd)
	)
		throw new Error("Unsafe execution workspace layout");
	const storage = dirname(dirname(dirname(workspace.root)));
	for (const path of runtimeReadPaths) {
		canonical(path);
		if (
			path === "/" ||
			isWithin(storage, path) ||
			isWithin(path, storage) ||
			isWithin(policy.cwd, path) ||
			isWithin(path, policy.cwd)
		)
			throw new Error("Runtime read path exposes source or private execution storage");
	}
	const denyRead: string[] = [];
	const denyWrite: string[] = [];
	for (const rule of policy.denyRules) {
		const parsed = pathRule(rule);
		if (!parsed) continue;
		if (!parsed.path || parsed.path.includes("\0")) throw new Error("Unrepresentable execution deny rule");
		if (parsed.verb === "Read" && ["*", "**", "/", "/**"].includes(parsed.path))
			throw new Error("Unrepresentable broad execution read denial");
		let path: string;
		if (parsed.path.startsWith("~/")) path = join(homedir(), parsed.path.slice(2));
		else if (parsed.path.startsWith("//")) path = parsed.path.slice(1);
		else if (isAbsolute(parsed.path)) path = parsed.path;
		else path = resolve(parsed.path.startsWith("**/") ? workspace.root : workspace.executionCwd, parsed.path);
		if (path.startsWith(`${policy.cwd}/`)) path = join(workspace.executionCwd, path.slice(policy.cwd.length + 1));
		(parsed.verb === "Read" ? denyRead : denyWrite).push(path);
	}
	const literal = (path: string) => ({ path, literal: true as const });
	return {
		network: {
			allowedDomains: [],
			deniedDomains: [],
			strictAllowlist: true,
			allowUnixSockets: [],
			allowAllUnixSockets: false,
			allowLocalBinding: false,
			allowMachLookup: [],
			denyMachLookup: [...REQUIRED_MACH_LOOKUP_DENIALS],
		},
		filesystem: {
			denyRead: [literal("/"), ...denyRead],
			allowRead: [workspace.root, workspace.scratchDir, ...runtimeReadPaths].map(literal),
			allowWrite: [workspace.root, workspace.scratchDir].map(literal),
			denyWrite: [literal(workspace.gitDir), literal("/tmp/claude"), literal("/private/tmp/claude"), ...denyWrite],
			allowGitConfig: false,
		},
	};
}
