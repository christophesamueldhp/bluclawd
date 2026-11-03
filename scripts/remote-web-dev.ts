// The phone app against a local remote server with three fake panes, to check a change to
// daemon/remote/web/ in a browser: `node scripts/remote-web-dev.ts`, open the URL it prints and pair
// with its code. What the app sends a pane is printed. Creating `<dir>/moved` moves Alpha's session
// to another pane, as a resume does; the app follows it on its next list (reopen the stream, or
// refresh). Alpha and Beta send no report, as panes from an older build: every status request
// answers 404 `no_status`. Gamma reports its prompts' outcomes, as a current pane does: taken, and
// written to its transcript, or queued while `<dir>/busy` exists (Gamma is working then). While
// `<dir>/compacting` exists Gamma refuses them (compacting), and while `<dir>/gone` exists they are
// lost, as when Gamma's pane goes before taking them. Creating `<dir>/reply` makes Alpha stream a
// reply that runs a tool (see streamReply).
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { InstanceSummary, PaneMessage } from "../daemon/ipc/protocol.ts";
import { PromptDelivery } from "../daemon/remote/delivery.ts";
import { type RemoteServer, startRemoteServer } from "../daemon/remote/http.ts";
import { RemoteStore } from "../daemon/remote/pairing.ts";

const dir = mkdtempSync(join(tmpdir(), "bluclawd-remote-web-"));
let entries = 0;
/** Each session file's last entry, which the next one follows. */
const leaves = new Map<string, string>();
/** The line of `path`'s next entry; written by the caller, now or later. */
function entry(path: string, message: Record<string, unknown>): string {
	const id = (++entries).toString(16).padStart(8, "0");
	const line = `${JSON.stringify({ type: "message", id, parentId: leaves.get(path) ?? null, message })}\n`;
	leaves.set(path, id);
	return line;
}
function append(path: string, role: string, content: string): void {
	appendFileSync(path, entry(path, { role, content }));
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
			if (existsSync(join(dir, "gone"))) delivery.lost(id, [message]);
			else if (existsSync(join(dir, "compacting")))
				delivery.reported(id, [{ id: promptId, outcome: "refused", reason: "compacting" }]);
			else {
				const outcome = busy() ? "queued" : "taken";
				if (outcome === "taken") append(gamma.sessionFile!, "user", message.text);
				delivery.reported(id, [{ id: promptId, outcome }]);
			}
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
		claimStart: () => ({ ok: true, id: "pi-new" }),
		paneStarting: () => {},
		startFailed: () => {},
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

/**
 * Alpha's reply, as a pane streams it: its text, then its end naming the entry, then a tool-only
 * snapshot while the tool runs. The entry is written 2 s after its end, later than pi does, so the
 * text is seen held until the transcript has it; then the tool's result, and the turn's bare end.
 */
async function streamReply(): Promise<void> {
	const path = panes[0]!.sessionFile!;
	const text = "Let me look at the files in this directory first.";
	const call = { id: `call-${entries}`, name: "bash", summary: "ls" };
	const words = text.split(" ");
	for (let n = 1; n <= words.length; n++) {
		server?.live("pi-alpha", { text: words.slice(0, n).join(" "), tools: [] });
		await sleep(300);
	}
	server?.live("pi-alpha", { text, tools: [{ ...call, running: false }] });
	const line = entry(path, {
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id: call.id, name: call.name, arguments: { command: "ls" } },
		],
	});
	server?.live("pi-alpha", null, leaves.get(path));
	server?.live("pi-alpha", { text: "", tools: [{ ...call, running: true }] });
	await sleep(2000);
	appendFileSync(path, line);
	await sleep(1500);
	appendFileSync(path, entry(path, { role: "toolResult", toolCallId: call.id, toolName: "bash", content: "a.ts" }));
	server?.live("pi-alpha", null);
}

setInterval(() => {
	const trigger = join(dir, "reply");
	if (!existsSync(trigger)) return;
	rmSync(trigger);
	void streamReply();
}, 500);
