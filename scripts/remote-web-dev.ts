// The phone app against a local remote server with three fake panes, to check a change to
// daemon/remote/web/ in a browser: `node scripts/remote-web-dev.ts`, open the URL it prints and pair
// with its code. What the app sends a pane is printed. Creating `<dir>/moved` moves Alpha's session
// to another pane, as a resume does; the app follows it on its next list (reopen the stream, or
// refresh). Alpha and Beta send no report, as panes from an older build: every status request
// answers 404 `no_status`. Gamma reports its prompts' outcomes, as a current pane does: taken, and
// written to its transcript, or queued while `<dir>/busy` exists (Gamma is working then).
import { appendFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstanceSummary, PaneMessage } from "../daemon/ipc/protocol.ts";
import { PromptDelivery } from "../daemon/remote/delivery.ts";
import { type RemoteServer, startRemoteServer } from "../daemon/remote/http.ts";
import { RemoteStore } from "../daemon/remote/pairing.ts";

const dir = mkdtempSync(join(tmpdir(), "bluclawd-remote-web-"));
let entries = 0;
/** Each session file's last entry, which the next one follows. */
const lastEntry = new Map<string, string>();
function append(path: string, role: string, content: string): void {
	const id = (++entries).toString(16).padStart(8, "0");
	appendFileSync(
		path,
		`${JSON.stringify({ type: "message", id, parentId: lastEntry.get(path) ?? null, message: { role, content } })}\n`,
	);
	lastEntry.set(path, id);
}
function sessionFile(name: string): string {
	const path = join(dir, `${name}.jsonl`);
	writeFileSync(path, "");
	append(path, "user", `Hello ${name}`);
	append(path, "assistant", `Reply in ${name}`);
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
const panes = [
	pane("pi-alpha", "Alpha", "session-alpha"),
	pane("pi-beta", "Beta", "session-beta"),
	pane("pi-gamma", "Gamma", "session-gamma"),
];
const gamma = panes[2]!;
const busy = () => existsSync(join(dir, "busy"));

let server: RemoteServer | undefined;
/** Gamma's heartbeat takes the prompt a moment later, and its pi takes it or queues it. */
const delivery = new PromptDelivery((id, message) => {
	console.log("sent", id, JSON.stringify(message));
	if (id === gamma.id && message.type === "prompt" && message.id) {
		const promptId = message.id;
		setTimeout(() => {
			delivery.delivered(id, [message]);
			const outcome = busy() ? "queued" : "taken";
			if (outcome === "taken") append(gamma.sessionFile!, "user", message.text);
			delivery.reported(id, [{ id: promptId, outcome }]);
			server?.status(id);
		}, 500);
	}
	return true;
});

const store = new RemoteStore(join(dir, "remote.json"));
server = await startRemoteServer(
	{
		store,
		webDir: join(import.meta.dirname, "../daemon/remote/web"),
		listInstances: () => {
			const listed = panes.map((p) => (p === gamma && busy() ? { ...p, activity: "working" as const } : p));
			return existsSync(join(dir, "moved"))
				? listed.map((p) => (p.id === "pi-alpha" ? { ...p, id: "pi-alpha-2", pane: "pi-alpha-2" } : p))
				: listed;
		},
		send: (id: string, message: PaneMessage) => delivery.send(id, message),
		launch: () => undefined,
		startSession: () => "pi-new",
		terminalOpen: () => true,
		report: (id) => (id === gamma.id ? { models: [], outcomes: [] } : undefined),
		outcomes: (id) => delivery.outcomes(id),
		renameInstance: () => true,
		setPinned: () => true,
		deleteInstance: () => true,
	},
	0,
);
console.log(`http://127.0.0.1:${server.port}/  pairing code ${store.createCode().code}  dir ${dir}`);
