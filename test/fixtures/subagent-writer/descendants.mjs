import { spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readinessMs } from "../../helpers/heartbeats.ts";

const [mode, heartbeatPath, identity, lifetimeText] = process.argv.slice(2);
const lifetime = Number(lifetimeText);
const source = fileURLToPath(import.meta.url);
process.title = identity;

if (mode === "leaf" || mode === "attached") {
	let sequence = 0;
	const beat = () => appendFileSync(heartbeatPath, JSON.stringify({
		identity, pid: process.pid, ppid: process.ppid, sequence: ++sequence,
	}) + "\n");
	writeFileSync(heartbeatPath + ".identity", JSON.stringify({
		identity, pid: process.pid, expiresAt: Date.now() + lifetime,
	}));
	beat();
	const timer = setInterval(beat, 25);
	setTimeout(() => { clearInterval(timer); process.exit(0); }, lifetime);
} else if (mode === "intermediate") {
	const child = spawn(process.execPath, [source, "leaf", heartbeatPath, identity, lifetimeText], {
		detached: true,
		stdio: "ignore",
		env: process.env,
	});
	child.unref();
} else {
	const child = spawn(process.execPath, [
		source, mode === "double-fork" ? "intermediate" : "leaf", heartbeatPath, identity, lifetimeText,
	], {
		detached: mode === "detached",
		stdio: mode === "inherited-stdio" ? "inherit" : "ignore",
		env: process.env,
	});
	child.unref();
	// Keep the invoking command alive so cancellation, not natural exit, is the boundary: counted
	// from the leaf's first beat, since under load the leaf starts seconds late (#76).
	const started = setInterval(() => {
		if (!existsSync(heartbeatPath)) return;
		clearInterval(started);
		setTimeout(() => process.exit(0), lifetime + 1000);
	}, 25);
	// A leaf that never starts must not keep the command alive forever.
	setTimeout(() => process.exit(0), 2 * readinessMs);
}
