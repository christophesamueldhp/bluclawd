import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildExecutionSandboxConfig,
	createIsolatedSubagentPolicySnapshot,
} from "../../ext/subagents/execution-policy.ts";
import { captureSourceSnapshot } from "../../ext/subagents/source-snapshot.ts";
import { createIsolatedWorkspace } from "../../ext/subagents/workspace.ts";
import { createSubagentFixture } from "./subagent-fixture.ts";

export const nativeExecutionCandidate = process.platform === "darwin" && process.arch === "arm64";
type BrokerLookup = { service: string; status: "denied" | "reachable" | "unavailable" | "unknown" };

export function classifyBrokerLookups(
	beforeJson: string,
	insideJson: string,
	afterJson: string,
): readonly BrokerLookup[] {
	const services = ["com.apple.securityd.xpc", "com.apple.SecurityServer"];
	const parse = (json: string) => {
		try {
			const probe = JSON.parse(json);
			if (probe?.version !== 1 || !Array.isArray(probe.lookups) || probe.lookups.length !== 2) throw new Error();
			const codes = new Map<string, number>();
			for (const lookup of probe.lookups) {
				if (
					!lookup ||
					!services.includes(lookup.service) ||
					!Number.isSafeInteger(lookup.kr) ||
					codes.has(lookup.service)
				)
					throw new Error();
				codes.set(lookup.service, lookup.kr);
			}
			return codes;
		} catch {
			throw new Error("Invalid broker lookup probe response.");
		}
	};
	const before = parse(beforeJson),
		inside = parse(insideJson),
		after = parse(afterJson);
	return services.map((service) => {
		let status: BrokerLookup["status"] = "unknown";
		if (inside.get(service) === 0) status = "reachable";
		else if (before.get(service) === 0 && after.get(service) === 0 && [1100, 1102].includes(inside.get(service)!))
			status = "denied";
		else if (before.get(service) === 1102 && after.get(service) === 1102) status = "unavailable";
		return { service, status };
	});
}

export function requireBrokerLookupDenial(
	beforeJson: string,
	insideJson: string,
	afterJson: string,
): readonly BrokerLookup[] {
	const coverage = classifyBrokerLookups(beforeJson, insideJson, afterJson);
	if (
		!coverage.some((r) => r.status === "denied") ||
		coverage.some((r) => r.status === "reachable" || r.status === "unknown")
	)
		throw new Error("Native broker lookup denial was not demonstrated.");
	return coverage;
}
export interface ProbeOperation {
	tool: string;
	input: Record<string, unknown>;
}
export interface ProbeReport {
	results: Array<{ ok: boolean; text: string }>;
	parentResult: { ok: boolean; text: string };
	parentConfigUnchanged: boolean;
	workerExitObserved: boolean;
	parentWriteWhileChildWaiting: boolean;
	parentMachAllows: string[];
}
export async function createExecutionFixture(denyRules: string[] = []) {
	const f = await createSubagentFixture();
	try {
		const policy = createIsolatedSubagentPolicySnapshot({
			cwd: f.parentCwd,
			denyRules,
			allowedTools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
		}).snapshot!;
		const signal = new AbortController().signal;
		const source = await captureSourceSnapshot({
			agentDir: f.stateDir,
			parentSessionId: "parent",
			runtimeGeneration: 1,
			policy,
			exec: f.exec,
			signal,
			isCurrent: () => true,
		});
		const create = async () => {
			const runId = `sub_${randomUUID()}`;
			const workspace = await createIsolatedWorkspace({
				runId,
				runDir: join(f.stateDir, "bluclawd", "subagents", "parent", runId),
				source,
				exec: f.exec,
				signal,
				isCurrent: () => true,
			});
			f.scratchDirs.push(workspace.scratchDir);
			return workspace;
		};
		const workspace = await create();
		const sibling = await create();
		const host = fileURLToPath(new URL("../fixtures/subagent-execution/tool-host.mjs", import.meta.url));
		const controller = fileURLToPath(new URL("../fixtures/subagent-execution/probe-controller.mjs", import.meta.url));
		const modules = await realpath(fileURLToPath(new URL("../../node_modules", import.meta.url)));
		const sdkUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
		const srtUrl = import.meta.resolve("@anthropic-ai/sandbox-runtime");
		const runtimeReadPaths = [
			"/System/Library",
			"/usr/lib",
			"/usr/share",
			"/bin",
			"/usr/bin",
			"/dev/null",
			"/dev/zero",
			"/dev/fd",
			"/dev/tty",
			"/dev/random",
			"/dev/urandom",
			"/dev/dtracehelper",
			"/opt/homebrew/Cellar",
			"/opt/homebrew/opt",
			"/opt/homebrew/bin",
			modules,
			host,
		];
		for (const path of [join(workspace.scratchDir, "home"), join(workspace.scratchDir, "tmp")])
			await mkdir(path, { recursive: true });
		const parentLive = join(f.parentCwd, "parent-live.txt");
		await writeFile(parentLive, "before parent operation\n");
		const probe = async (
			operations: ProbeOperation[],
			options: { parentMachAllows?: readonly string[] } = {},
		): Promise<ProbeReport> => {
			const config = buildExecutionSandboxConfig(policy, workspace, runtimeReadPaths);
			return new Promise((resolve, reject) => {
				const child = spawn(process.execPath, [controller], {
					cwd: workspace.executionCwd,
					env: {
						PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
						HOME: join(workspace.scratchDir, "home"),
						TMPDIR: join(workspace.scratchDir, "tmp"),
						PI_OFFLINE: "1",
						BLUCLAWD_TEST_PARENT_CREDENTIAL: "synthetic-parent-credential",
					},
					stdio: ["pipe", "pipe", "pipe"],
					timeout: 15000,
					killSignal: "SIGKILL",
				});
				let stdout = "",
					failed = false;
				child.stdout.on("data", (data) => {
					if (stdout.length + data.length > 256 * 1024) {
						failed = true;
						child.kill("SIGKILL");
					} else stdout += data;
				});
				child.stderr.on("data", () => {
					failed = true;
				});
				child.on("error", () => {
					failed = true;
				});
				child.stdin.on("error", () => {
					failed = true;
				});
				child.once("close", (code) => {
					if (failed || code !== 0) {
						let phase = "transport";
						try {
							const report = JSON.parse(stdout);
							if (["initialization", "child_execution", "parent_execution"].includes(report.probeError))
								phase = report.probeError;
							if (/^Worker failed: [A-Za-z_]+ exit=-?[0-9]+$/.test(report.diagnostic))
								phase += `; ${report.diagnostic}`;
						} catch {}
						reject(new Error(`Native execution probe failed (${phase})`));
					} else {
						try {
							resolve(JSON.parse(stdout));
						} catch {
							reject(new Error("Invalid native execution probe response"));
						}
					}
				});
				child.stdin.end(
					JSON.stringify({
						config,
						sdkUrl,
						srtUrl,
						host,
						cwd: workspace.executionCwd,
						scratch: workspace.scratchDir,
						parentCwd: f.parentCwd,
						parentLive,
						parentMachAllows: [...(options.parentMachAllows ?? [])],
						operations,
					}),
				);
			});
		};
		return { f, policy, workspace, sibling, source, runtimeReadPaths, parentLive, probe, cleanup: () => f.cleanup() };
	} catch (error) {
		await f.cleanup();
		throw error;
	}
}
