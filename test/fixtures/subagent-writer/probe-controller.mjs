import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { reapDescendants } from "../../../ext/sandbox/reaper.ts";
import { readinessMs } from "../../helpers/heartbeats.ts";

const [workspace, parent, sibling, mode, heartbeatPath, identity, lifetime] = process.argv.slice(2);
const abort = new AbortController();
const input = createInterface({ input: process.stdin });
input.on("line", (line) => { if (line === "stop") abort.abort(); });
input.on("close", () => abort.abort());
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const quote = (text) => "'" + text.replace(/'/g, "'\\''") + "'";
// Outlasts the test's readiness deadline, as does the exec timeout: startup under load is slow (#76).
const outlastMs = 2 * readinessMs;
const watchdog = setTimeout(() => abort.abort(), outlastMs);

try {
	await SandboxManager.initialize({
		network: { allowedDomains: [], deniedDomains: [] },
		filesystem: {
			allowWrite: [workspace],
			denyWrite: [parent, sibling],
			denyRead: [parent],
		},
	}, async () => false, false);
	const descendant = fileURLToPath(new URL("./descendants.mjs", import.meta.url));
	const command = [process.execPath, descendant, mode, heartbeatPath, identity, lifetime].map(quote).join(" ");
	const wrapped = await SandboxManager.wrapWithSandbox(command, "/bin/bash", undefined, abort.signal);
	emit({ event: "ready" });
	try {
		const exec = reapDescendants(createLocalBashOperations({ shellPath: "/bin/bash" }).exec);
		const result = await exec(wrapped, workspace, {
			signal: abort.signal,
			onData: () => {},
			timeout: outlastMs / 1000,
			env: process.env,
		});
		emit({ event: "settled", code: result.exitCode });
	} catch (error) {
		if (!abort.signal.aborted) throw error;
		emit({ event: "settled", aborted: true });
	}
} catch (error) {
	emit({ event: "error", message: String(error.message).slice(0, 1000) });
	process.exitCode = 1;
} finally {
	clearTimeout(watchdog);
	input.close();
	SandboxManager.cleanupAfterCommand();
	await SandboxManager.reset();
}
