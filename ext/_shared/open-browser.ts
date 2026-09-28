// Vendored from pi's utils/open-browser.ts, which pi does not export.
import { spawn } from "node:child_process";

/**
 * Open a URL or file in the platform's default handler.
 *
 * Never invokes a shell: on Windows `cmd /c start` re-parses metacharacters
 * (&, |, ^, ...), which would make attacker-controlled URLs injectable.
 */
export function openBrowser(target: string): void {
	const [cmd, args]: [string, string[]] =
		process.platform === "darwin"
			? ["open", [target]]
			: process.platform === "win32"
				? ["rundll32", ["url.dll,FileProtocolHandler", target]]
				: ["xdg-open", [target]];

	// A missing launcher surfaces as an error event; best-effort, so it must not crash the process.
	spawn(cmd, args, { stdio: "ignore", detached: true })
		.on("error", () => {})
		.unref();
}
