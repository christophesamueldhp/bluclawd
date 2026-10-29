// The phone app against a local remote server with two fake panes, to check a change to
// daemon/remote/web/ in a browser: `node scripts/remote-web-dev.ts`, open the URL it prints and pair
// with its code. What the app sends a pane is printed. Creating `<dir>/moved` moves Alpha's session
// to another pane, as a resume does; the app follows it on its next list (reopen the stream, or
// refresh). No pane sends a report, so every status request answers 404 `no_status`.
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstanceSummary } from "../daemon/ipc/protocol.ts";
import { startRemoteServer } from "../daemon/remote/http.ts";
import { RemoteStore } from "../daemon/remote/pairing.ts";

const dir = mkdtempSync(join(tmpdir(), "bluclawd-remote-web-"));
let entries = 0;
function sessionFile(name: string): string {
	const entry = (role: string, content: string, parentId: string | null) =>
		`${JSON.stringify({ type: "message", id: `${(++entries).toString(16).padStart(8, "0")}`, parentId, message: { role, content } })}\n`;
	const path = join(dir, `${name}.jsonl`);
	const first = entry("user", `Hello ${name}`, null);
	writeFileSync(path, first + entry("assistant", `Reply in ${name}`, JSON.parse(first).id));
	return path;
}

// `external`: a pane's pi, so the app may prompt it; without it a prompt answers 409.
const pane = (id: string, label: string, sessionId: string): InstanceSummary => ({
	id,
	status: "online",
	cwd: dir,
	label,
	sessionId,
	sessionFile: sessionFile(label.toLowerCase()),
	activity: "idle",
	external: true,
	pane: id,
});
const panes = [pane("pi-alpha", "Alpha", "session-alpha"), pane("pi-beta", "Beta", "session-beta")];

const store = new RemoteStore(join(dir, "remote.json"));
const server = await startRemoteServer(
	{
		store,
		webDir: join(import.meta.dirname, "../daemon/remote/web"),
		listInstances: () =>
			existsSync(join(dir, "moved"))
				? panes.map((p) => (p.id === "pi-alpha" ? { ...p, id: "pi-alpha-2", pane: "pi-alpha-2" } : p))
				: panes,
		send: (id, message) => {
			console.log("sent", id, JSON.stringify(message));
			return true;
		},
		launch: () => undefined,
		startSession: () => "pi-new",
		terminalOpen: () => true,
		report: () => undefined,
		renameInstance: () => true,
		setPinned: () => true,
		deleteInstance: () => true,
	},
	0,
);
console.log(`http://127.0.0.1:${server.port}/  pairing code ${store.createCode().code}  dir ${dir}`);
