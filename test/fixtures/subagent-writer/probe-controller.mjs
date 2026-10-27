import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";

const [workspace, parent, sibling, mode, heartbeatPath, identity, lifetime] = process.argv.slice(2);
const abort = new AbortController();
const input = createInterface({ input: process.stdin });
input.on("line", (line) => { if (line === "stop") abort.abort(); });
input.on("close", () => abort.abort());
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const quote = (text) => "'" + text.replace(/'/g, "'\\''") + "'";
const watchdog = setTimeout(() => abort.abort(), 10000);

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
		const result = await createLocalBashOperations({ shellPath: "/bin/bash" }).exec(wrapped, workspace, {
			signal: abort.signal,
			onData: () => {},
			timeout: 8,
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
