/**
 * The sandbox the model's shell commands run in: Anthropic's sandbox runtime (`srt`), one per
 * process. The sandbox extension starts and stops it; background-bash runs every model command
 * through `wrapExec`.
 */
import { randomUUID } from "node:crypto";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { sharedRef } from "../_shared/global-state.ts";
import type { RuntimeConfig } from "./config.ts";

export type Exec = BashOperations["exec"];

/** Whether a sandboxed command may reach a host no rule covers. */
export type AskNetwork = (request: { host: string; port: number | undefined }) => Promise<boolean>;

/** The part of `srt`'s `SandboxManager` bluclawd calls. */
export interface SandboxEngine {
	isSupportedPlatform(): boolean;
	checkDependencies(): { errors: string[]; warnings: string[] };
	initialize(config: RuntimeConfig, ask: AskNetwork, enableLogMonitor: boolean): Promise<void>;
	updateConfig(config: RuntimeConfig): void;
	wrapWithSandbox(
		command: string,
		binShell: string | undefined,
		customConfig: undefined,
		signal: AbortSignal | undefined,
		options: { commandId: string; commandText: string },
	): Promise<string>;
	annotateStderrWithSandboxFailures(commandId: string, stderr: string): string;
	cleanupAfterCommand(): void;
	reset(): Promise<void>;
}

export type SandboxStatus = { kind: "off" } | { kind: "ready" } | { kind: "unavailable"; reason: string };

// Shared, since the sandbox extension and background-bash each load their own copy of this module.
const state = sharedRef<{ status: SandboxStatus; engine?: SandboxEngine }>("sandbox", { status: { kind: "off" } });

const LINUX_HINT =
	"install bubblewrap and socat (apt install bubblewrap socat); on Ubuntu 24.04+ also allow unprivileged user namespaces, see the README";

export function sandboxStatus(): SandboxStatus {
	return state.get().status;
}

function setStatus(status: SandboxStatus): SandboxStatus {
	state.set({ ...state.get(), status });
	return status;
}

/** Swaps the engine, for tests; undefined loads `srt` again on the next start. */
export function setSandboxEngine(engine: SandboxEngine | undefined): void {
	state.set({ ...state.get(), engine });
}

async function engine(): Promise<SandboxEngine> {
	const current = state.get().engine;
	if (current) return current;
	// Loaded when a sandbox first starts, so a session without one never loads it.
	const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
	const loaded = SandboxManager as unknown as SandboxEngine;
	setSandboxEngine(loaded);
	return loaded;
}

export function markSandboxUnavailable(reason: string): SandboxStatus {
	return setStatus({ kind: "unavailable", reason });
}

export async function startSandbox(
	config: RuntimeConfig,
	ask: AskNetwork,
	platform: NodeJS.Platform = process.platform,
): Promise<SandboxStatus> {
	if (platform === "win32") {
		return markSandboxUnavailable("the sandbox needs macOS, Linux or WSL2; on Windows run pi in WSL2");
	}
	try {
		const sandbox = await engine();
		if (state.get().status.kind === "ready") {
			sandbox.updateConfig(config);
			return sandboxStatus();
		}
		if (!sandbox.isSupportedPlatform()) return markSandboxUnavailable(`the sandbox does not support ${platform}`);
		const { errors } = sandbox.checkDependencies();
		if (errors.length > 0) {
			return markSandboxUnavailable(
				platform === "linux" ? `${errors.join("; ")}: ${LINUX_HINT}` : errors.join("; "),
			);
		}
		await sandbox.initialize(config, ask, true);
		return setStatus({ kind: "ready" });
	} catch (error) {
		return markSandboxUnavailable(error instanceof Error ? error.message : String(error));
	}
}

export async function stopSandbox(): Promise<void> {
	const { status, engine: sandbox } = state.get();
	setStatus({ kind: "off" });
	if (status.kind === "ready" && sandbox) await sandbox.reset();
}

/**
 * `exec` run inside the sandbox while it is ready, refused while it is on but cannot run, and
 * unchanged while it is off. The wrapped command must run asynchronously: `srt`'s proxy lives on
 * this process's event loop.
 */
export function wrapExec(exec: Exec, shellPath: () => string | undefined): Exec {
	return async (command, cwd, options) => {
		const { status, engine: sandbox } = state.get();
		if (status.kind === "off") return exec(command, cwd, options);
		if (status.kind === "unavailable" || !sandbox) {
			const reason = status.kind === "unavailable" ? status.reason : "it has not started";
			throw new Error(`The sandbox is on but cannot run: ${reason}`);
		}
		const commandId = randomUUID();
		const wrapped = await sandbox.wrapWithSandbox(command, shellPath(), undefined, options.signal, {
			commandId,
			commandText: command,
		});
		try {
			return await exec(wrapped, cwd, options);
		} finally {
			const blocked = sandbox.annotateStderrWithSandboxFailures(commandId, "").trim();
			if (blocked) options.onData(Buffer.from(`\n${blocked}\n`));
			sandbox.cleanupAfterCommand();
		}
	};
}
