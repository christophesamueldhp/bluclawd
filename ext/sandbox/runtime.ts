/**
 * The sandbox the model's shell commands run in: Anthropic's sandbox runtime (`srt`), one per
 * process. The sandbox extension starts and stops it; background-bash runs every model command
 * through `wrapExec`.
 */
import { randomUUID } from "node:crypto";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { sharedRef } from "../_shared/global-state.ts";
import { checkRuntimeConfig, type RuntimeConfig } from "./config.ts";
import { reapDescendants } from "./reaper.ts";

export type Exec = BashOperations["exec"];

/** Whether a sandboxed command may reach a host no rule covers. */
export type AskNetwork = (request: { host: string; port: number | undefined }) => Promise<boolean>;

/** The part of `srt`'s `SandboxManager` bluclawd calls. */
export interface SandboxEngine {
	isSupportedPlatform(): boolean;
	checkDependencies(): { errors: string[]; warnings: string[] };
	/**
	 * Linux: whether `srt` finds the `apply-seccomp` binary that blocks Unix sockets. Without it `srt` leaves them all
	 * open and only warns.
	 */
	canBlockUnixSockets(seccomp: SandboxRuntimeConfig["seccomp"]): Promise<boolean>;
	initialize(config: SandboxRuntimeConfig, ask: AskNetwork, enableLogMonitor: boolean): Promise<void>;
	updateConfig(config: SandboxRuntimeConfig): void;
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
const state = sharedRef<{
	status: SandboxStatus;
	engine?: SandboxEngine;
	/** Whether `srt` is initialized, which `markSandboxUnavailable` does not undo. */
	initialized: boolean;
	/** Whether a wrapped exec exists, i.e. bluclawd's bash is loaded. */
	wrapped: boolean;
	ask: AskNetwork;
	/** Start and stop run one at a time, in call order. */
	queue: Promise<unknown>;
}>("sandbox", {
	status: { kind: "off" },
	initialized: false,
	wrapped: false,
	ask: async () => false,
	queue: Promise.resolve(),
});

function serialized<T>(task: () => Promise<T>): Promise<T> {
	const run = state.get().queue.then(task);
	state.set({ ...state.get(), queue: run.catch(() => undefined) });
	return run;
}

const LINUX_HINT =
	"install bubblewrap, socat and ripgrep (apt install bubblewrap socat ripgrep); on Ubuntu 24.04+ also allow unprivileged user namespaces, see the README";

const NO_UNIX_SOCKET_FILTER =
	"Unix sockets cannot be blocked: the sandbox runtime's apply-seccomp binary was not found; " +
	"reinstall bluclawd, set sandbox.seccomp.applyPath to a working apply-seccomp, " +
	"or set sandbox.network.allowAllUnixSockets to true to let commands reach every Unix socket";

/**
 * The hosts the user let the model's commands reach this session, as `host:port`: a subagent run asking for one of
 * them is not asked about again (ext/subagents/generations.ts).
 */
const allowedHosts = sharedRef<Set<string>>("sandbox-allowed-hosts", new Set());

export function noteHostAllowed(target: string): void {
	allowedHosts.get().add(target);
}

export function hostAllowed(target: string): boolean {
	return allowedHosts.get().has(target);
}

export function forgetAllowedHosts(): void {
	allowedHosts.get().clear();
}

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
	// The lookup `srt` makes when it wraps a command; its package has no export map.
	const { getApplySeccompBinaryPathAsync } = await import(
		"@anthropic-ai/sandbox-runtime/dist/sandbox/generate-seccomp-filter.js"
	);
	const loaded: SandboxEngine = {
		...SandboxManager,
		// `srt` takes any non-empty `argv0` as a binary compiled into its caller.
		canBlockUnixSockets: async (seccomp) =>
			Boolean(seccomp?.argv0) || (await getApplySeccompBinaryPathAsync(seccomp?.applyPath)) !== null,
	};
	setSandboxEngine(loaded);
	return loaded;
}

export function markSandboxUnavailable(reason: string): SandboxStatus {
	return setStatus({ kind: "unavailable", reason });
}

export function startSandbox(
	config: RuntimeConfig,
	ask: AskNetwork,
	platform: NodeJS.Platform = process.platform,
): Promise<SandboxStatus> {
	return serialized(() => start(config, ask, platform));
}

async function start(config: RuntimeConfig, ask: AskNetwork, platform: NodeJS.Platform): Promise<SandboxStatus> {
	// `srt` keeps the callback it gets at initialize, so it gets one that follows the latest session's.
	state.set({ ...state.get(), ask });
	if (platform === "win32") {
		return markSandboxUnavailable("the sandbox needs macOS, Linux or WSL2; on Windows run pi in WSL2");
	}
	try {
		const checked = await checkRuntimeConfig(config);
		if (typeof checked === "string") return markSandboxUnavailable(checked);
		const sandbox = await engine();
		// Checked on every start, since a settings change can drop `allowAllUnixSockets` from a running sandbox.
		const unixSocketsOpen = async () =>
			platform === "linux" &&
			checked.network.allowAllUnixSockets !== true &&
			!(await sandbox.canBlockUnixSockets(checked.seccomp));
		if (state.get().initialized) {
			if (await unixSocketsOpen()) return markSandboxUnavailable(NO_UNIX_SOCKET_FILTER);
			sandbox.updateConfig(checked);
			return setStatus({ kind: "ready" });
		}
		if (!sandbox.isSupportedPlatform()) return markSandboxUnavailable(`the sandbox does not support ${platform}`);
		const { errors } = sandbox.checkDependencies();
		if (errors.length > 0) {
			return markSandboxUnavailable(
				platform === "linux" ? `${errors.join("; ")}: ${LINUX_HINT}` : errors.join("; "),
			);
		}
		if (await unixSocketsOpen()) return markSandboxUnavailable(NO_UNIX_SOCKET_FILTER);
		await sandbox.initialize(checked, (request) => state.get().ask(request), true);
		state.set({ ...state.get(), initialized: true });
		return setStatus({ kind: "ready" });
	} catch (error) {
		return markSandboxUnavailable(error instanceof Error ? error.message : String(error));
	}
}

export function sandboxWraps(): boolean {
	return state.get().wrapped;
}

/** Forgets that a wrapped exec exists, until background-bash loads and wraps again. */
export function forgetWrappedExec(): void {
	state.set({ ...state.get(), wrapped: false });
}

export function stopSandbox(): Promise<void> {
	return serialized(async () => {
		const { initialized, engine: sandbox } = state.get();
		state.set({ ...state.get(), status: { kind: "off" }, initialized: false });
		if (initialized && sandbox) await sandbox.reset();
	});
}

/**
 * `exec` run inside the sandbox while it is ready, refused while it is on but cannot run, and
 * unchanged while it is off; on macOS its descendants are killed when it ends (`reaper.ts`). The
 * wrapped command must run asynchronously: `srt`'s proxy lives on this process's event loop.
 */
export function wrapExec(exec: Exec, shellPath: () => string | undefined): Exec {
	// Recorded at load: pi's own bash, which this does not wrap, runs when no wrapped exec is ever created.
	state.set({ ...state.get(), wrapped: true });
	const reapingExec = reapDescendants(exec);
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
			return await reapingExec(wrapped, cwd, options);
		} finally {
			const blocked = sandbox.annotateStderrWithSandboxFailures(commandId, "").trim();
			if (blocked) options.onData(Buffer.from(`\n${blocked}\n`));
			sandbox.cleanupAfterCommand();
		}
	};
}
