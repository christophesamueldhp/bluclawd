// The phone app against a local remote server with two fake panes, to check a change to
// daemon/remote/web/ in a browser: `node scripts/remote-web-dev.ts`, open the URL it prints and pair
// with its code. What the app sends a pane is printed. Creating `<dir>/moved` moves Alpha's session
// to another pane, as a resume does; the app follows it on its next list (reopen the stream, or
// refresh). Creating `<dir>/reply` makes Alpha stream a reply that runs a tool (see streamReply).
// No pane sends a report, so every status request answers 404 `no_status`.
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { InstanceSummary } from "../daemon/ipc/protocol.ts";
import { startRemoteServer } from "../daemon/remote/http.ts";
import { RemoteStore } from "../daemon/remote/pairing.ts";

const dir = mkdtempSync(join(tmpdir(), "bluclawd-remote-web-"));
let entries = 0;
/** Each session file's last entry, which the next one follows. */
const leaves = new Map<string, string>();
function entry(path: string, message: Record<string, unknown>): string {
	const id = (++entries).toString(16).padStart(8, "0");
	const line = `${JSON.stringify({ type: "message", id, parentId: leaves.get(path) ?? null, message })}\n`;
	leaves.set(path, id);
	return line;
}
function sessionFile(name: string): string {
	const path = join(dir, `${name}.jsonl`);
	const first = entry(path, { role: "user", content: `Hello ${name}` });
	writeFileSync(path, first + entry(path, { role: "assistant", content: `Reply in ${name}` }));
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

/**
 * Alpha's reply, as a pane streams it: its text, then its end naming the entry, then a tool-only
 * snapshot while the tool runs. The entry is written 2 s after its end, later than pi does, so the
 * text is seen held until the transcript has it; then the tool's result, and the turn's bare end.
 */
async function streamReply(): Promise<void> {
	const path = panes[0].sessionFile ?? "";
	const text = "Let me look at the files in this directory first.";
	const call = { id: `call-${entries}`, name: "bash", summary: "ls" };
	const words = text.split(" ");
	for (let n = 1; n <= words.length; n++) {
		server.live("pi-alpha", { text: words.slice(0, n).join(" "), tools: [] });
		await sleep(300);
	}
	server.live("pi-alpha", { text, tools: [{ ...call, running: false }] });
	const line = entry(path, {
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id: call.id, name: call.name, arguments: { command: "ls" } },
		],
	});
	server.live("pi-alpha", null, leaves.get(path));
	server.live("pi-alpha", { text: "", tools: [{ ...call, running: true }] });
	await sleep(2000);
	appendFileSync(path, line);
	await sleep(1500);
	appendFileSync(path, entry(path, { role: "toolResult", toolCallId: call.id, toolName: "bash", content: "a.ts" }));
	server.live("pi-alpha", null);
}

setInterval(() => {
	const trigger = join(dir, "reply");
	if (!existsSync(trigger)) return;
	rmSync(trigger);
	void streamReply();
}, 500);
