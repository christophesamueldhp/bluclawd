import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

let input = "";
for await (const chunk of process.stdin) {
	input += chunk;
	if (input.length > 64 * 1024) throw new Error("Controller input limit");
}
const request = JSON.parse(input);
const { SandboxManager } = await import(request.srtUrl);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
let phase = "initialization";
async function run(cwd, operations, config) {
	const command = [process.execPath, request.host].map(quote).join(" ");
	const wrapped = await SandboxManager.wrapWithSandbox(command, "/bin/bash", config, undefined, { commandId: crypto.randomUUID() });
	const env = {
		PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
		HOME: join(request.scratch, "home"), TMPDIR: join(request.scratch, "tmp"), OPENSSL_CONF: "/dev/null",
		PI_OFFLINE: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0",
	};
	return new Promise((resolve, reject) => {
		const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", wrapped], {
			cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"], timeout: 10000, killSignal: "SIGKILL",
		});
		let stdout = "", failed = false, diagnostic = "none";
		child.stdout.on("data", (chunk) => {
			if (stdout.length + chunk.length > 256 * 1024) { failed = true; child.kill("SIGKILL"); }
			else stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			failed = true;
			const text = String(chunk);
			const category = ["ERR_MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED", "EPERM", "EACCES", "ENOENT", "dyld", "SyntaxError", "TypeError"].find((code) => text.includes(code));
			if (category) diagnostic = category;
			else if (diagnostic === "none") diagnostic = "stderr";
		});
		child.on("error", () => { failed = true; });
		child.stdin.on("error", () => { failed = true; });
		child.once("close", (code) => {
			SandboxManager.cleanupAfterCommand();
			if (failed || code !== 0) reject(new Error(`Worker failed: ${diagnostic} exit=${code}`));
			else { try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Worker response failed")); } }
		});
		child.stdin.end(JSON.stringify({ sdkUrl: request.sdkUrl, cwd, operations }));
	});
}
async function waitForReady(path, finished) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (finished()) throw new Error("Worker finished before release");
		try { if (await readFile(path, "utf8") === "ready") return; }
		catch (error) { if (error.code !== "ENOENT") throw error; }
		await delay(10);
	}
	throw new Error("Worker readiness timeout");
}
try {
	if (!SandboxManager.isSupportedPlatform() || SandboxManager.checkDependencies().errors.length) throw new Error("Native prerequisites unavailable");
	const parentConfig = {
		network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true, allowLocalBinding: false, allowUnixSockets: [], allowMachLookup: request.parentMachAllows },
		filesystem: { denyRead: [], allowWrite: [request.parentCwd, request.scratch], denyWrite: [] },
	};
	await SandboxManager.initialize(parentConfig, async () => false, false);
	const before = JSON.stringify(SandboxManager.getConfig());
	const parentMachAllows = [...(SandboxManager.getConfig().network.allowMachLookup ?? [])];
	const id = crypto.randomUUID();
	const ready = join(request.cwd, `.probe-ready-${id}`);
	const release = join(request.cwd, `.probe-release-${id}`);
	const readySource = `
		const fs = require("node:fs");
		fs.writeFileSync(${JSON.stringify(ready)}, "ready", {flag:"wx", mode:0o600});
		const deadline = setTimeout(() => process.exit(1), 5000);
		const poll = setInterval(() => {
			try {
				if (fs.readFileSync(${JSON.stringify(release)}, "utf8") !== "release") return;
				clearTimeout(deadline); clearInterval(poll); console.log("released");
			} catch (error) { if (error.code !== "ENOENT") process.exit(1); }
		}, 10);
	`;
	const readyOperation = { tool: "bash", input: { command: [process.execPath, "-e", readySource].map(quote).join(" ") } };
	phase = "child_execution";
	let childFinished = false;
	const childRun = run(request.cwd, [readyOperation, ...request.operations], request.config).then(
		(child) => { childFinished = true; return { child }; },
		(error) => { childFinished = true; return { error }; },
	);
	try {
		await waitForReady(ready, () => childFinished);
		phase = "parent_execution";
		const parent = await run(request.parentCwd, [{ tool: "write", input: { path: request.parentLive, content: "parent operation still allowed\n" } }]);
		if (!parent.results[0]?.ok || childFinished) throw new Error("Concurrent parent write not observed");
		await writeFile(release, "release", { flag: "wx", mode: 0o600 });
		phase = "child_execution";
		const outcome = await childRun;
		if (outcome.error) throw outcome.error;
		const child = outcome.child;
		if (!child.results[0]?.ok || child.results[0].text.trim() !== "released") throw new Error("Worker coordination failed");
		const parentConfigUnchanged = before === JSON.stringify(SandboxManager.getConfig());
		await SandboxManager.reset();
		process.stdout.write(JSON.stringify({ results: child.results.slice(1), parentResult: parent.results[0], parentMachAllows, parentConfigUnchanged, workerExitObserved: true, parentWriteWhileChildWaiting: true }));
	} finally {
		await childRun;
	}
} catch (error) {
	await SandboxManager.reset();
	process.stdout.write(JSON.stringify({ probeError: phase, diagnostic: /^Worker failed: [A-Za-z_]+ exit=-?[0-9]+$/.test(error.message) ? error.message : "initialization_or_wrap" }));
	process.exitCode = 1;
}
