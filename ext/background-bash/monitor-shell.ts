import { spawn } from "node:child_process";
import { constants } from "node:os";
import { delimiter, join } from "node:path";
import { getAgentDir, getShellConfig } from "@earendil-works/pi-coding-agent";
import { sharedRef } from "../_shared/global-state.ts";
import type { BackgroundExec } from "./background-bash.ts";

const children = sharedRef("monitor-shell", { stops: new Set<() => void>(), watching: false }).get();

function shellEnvironment(): NodeJS.ProcessEnv {
	const key = Object.keys(process.env).find((name) => name.toLowerCase() === "path") ?? "PATH";
	const entries = (process.env[key] ?? "").split(delimiter).filter(Boolean);
	const bin = join(getAgentDir(), "bin");
	if (!entries.includes(bin)) entries.unshift(bin);
	return { ...process.env, [key]: entries.join(delimiter) };
}

export function monitorShellExec(shellPath: () => string | undefined): BackgroundExec {
	return async (command, cwd, { onData, onStderr = onData, signal, timeout, env }) => {
		if (signal?.aborted) throw new Error("aborted");
		const { shell, args, commandTransport } = getShellConfig(shellPath());
		const fromStdin = commandTransport === "stdin";
		const windows = process.platform === "win32";
		const child = spawn(shell, fromStdin ? args : [...args, command], {
			cwd,
			env: env ?? shellEnvironment(),
			detached: !windows,
			stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		if (fromStdin) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(command);
		}
		const stop = () => {
			if (!child.pid) return;
			if (windows) {
				const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
				spawn(taskkill, ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true }).once(
					"error",
					() => child.kill("SIGKILL"),
				);
				return;
			}
			if (process.platform === "darwin") {
				// macOS can wake a waiting shell when it kills a child before it signals the shell.
				try {
					process.kill(-child.pid, "SIGSTOP");
				} catch {}
			}
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		if (!children.watching) {
			children.watching = true;
			process.once("exit", () => {
				for (const stop of children.stops) stop();
			});
		}
		children.stops.add(stop);
		signal?.addEventListener("abort", stop, { once: true });
		let timedOut = false;
		const deadline =
			timeout === undefined
				? undefined
				: setTimeout(() => {
						timedOut = true;
						stop();
					}, timeout * 1000);
		let drain: ReturnType<typeof setTimeout> | undefined;
		try {
			const exitCode = await new Promise<number>((resolve, reject) => {
				let exited = false;
				const finish = (code: number | null, sig: NodeJS.Signals | null) =>
					resolve(code ?? (sig ? 128 + constants.signals[sig] : 1));
				const drainAfterExit = () => {
					if (!exited) return;
					clearTimeout(drain);
					drain = setTimeout(() => finish(child.exitCode, child.signalCode), 100);
				};
				child.stdout?.on("data", (data: Buffer) => {
					onData(data);
					drainAfterExit();
				});
				child.stderr?.on("data", (data: Buffer) => {
					onStderr(data);
					drainAfterExit();
				});
				child.once("error", reject);
				child.once("exit", () => {
					exited = true;
					drainAfterExit();
				});
				child.once("close", finish);
			});
			if (signal?.aborted) throw new Error("aborted");
			if (timedOut) throw new Error(`timeout:${timeout}`);
			return { exitCode };
		} finally {
			children.stops.delete(stop);
			signal?.removeEventListener("abort", stop);
			clearTimeout(deadline);
			clearTimeout(drain);
			child.stdout?.destroy();
			child.stderr?.destroy();
		}
	};
}
