// The phone app against a local remote server with three fake panes, to check a change to
// daemon/remote/web/ in a browser: `node scripts/remote-web-dev.ts`, open the URL it prints and pair
// with its code. What the app sends a pane is printed. Creating `<dir>/moved` moves Alpha's session
// to another pane, as a resume does; the app follows it on its next list (reopen the stream, or
// refresh). Alpha and Beta send no report, as panes from an older build, so every status request
// answers 404 `no_status`. Gamma reports its prompts' outcomes, as a current pane does: taken, and
// written to its transcript, or queued while `<dir>/busy` exists, when Gamma is working. While
// `<dir>/compacting` exists Gamma refuses them (compacting), and while `<dir>/gone` exists they are
// lost, as when Gamma's pane goes before taking them. Creating `<dir>/dequeue` has Gamma's pi drop
// the prompts it queued (lost, dequeued), as stopping its turn does. Creating `<dir>/quit` quits
// Gamma's pane for good. Its row stops, and what it was sent is lost (pane_gone). While `<dir>/slow`
// exists Gamma's status answers 5 s late, so a prompt can be sent before its report is in. While
// `<dir>/silent` exists Gamma's row is silent, as when its pi stopped beating and tmux still has it. It is listed
// alive, refuses prompts (409 `session_silent`) and answers no status; the app sees it on the next list.
// Creating `<dir>/reply` makes Alpha stream a reply that runs a tool (see streamReply), listed
// working until it ends, as a pane mid-turn is. While
// `<dir>/held` exists Gamma's heartbeat takes nothing, and creating `<dir>/restart` then starts
// prompt delivery afresh, as a daemon restart does. The app, asking about the prompts it still
// waits on, is answered lost (daemon_restarted). While `<dir>/closed` exists no terminal on the Mac
// shows pi, so every change is refused (409 `pi_not_open`) and the app only reads.
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
const leaves = new Map<string, string>();
function nextEntryLine(path: string, message: Record<string, unknown>): string {
	const id = (++entries).toString(16).padStart(8, "0");
	const line = `${JSON.stringify({ type: "message", id, parentId: leaves.get(path) ?? null, timestamp: new Date().toISOString(), message })}\n`;
	leaves.set(path, id);
	return line;
}
function append(path: string, role: string, content: string): void {
	appendFileSync(path, nextEntryLine(path, { role, content }));
}
function sessionFile(name: string): string {
	const path = join(dir, `${name}.jsonl`);
	writeFileSync(path, "");
	append(path, "user", `Hello ${name}`);
	append(path, "assistant", `Reply in ${name}`);
	return path;
}

const pane = (id: string, label: string, sessionId: string): InstanceSummary & { sessionFile: string } => ({
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
const alpha = pane("pi-alpha", "Alpha", "session-alpha");
const gamma = pane("pi-gamma", "Gamma", "session-gamma");
const panes = [alpha, pane("pi-beta", "Beta", "session-beta"), gamma];
let replying = false;
const busy = () => existsSync(join(dir, "busy"));
const queued: string[] = [];
let quit = false;
let quietAt = new Date().toISOString();
let wasBusy = false;
function listedGamma(): InstanceSummary {
	if (quit) return { ...gamma, status: "stopped", external: false };
	if (existsSync(join(dir, "silent"))) return { ...gamma, silent: true, external: false };
	const working = busy();
	if (wasBusy && !working) quietAt = new Date().toISOString();
	wasBusy = working;
	return working ? { ...gamma, activity: "working" } : { ...gamma, finishedAt: quietAt };
}

let server: RemoteServer | undefined;
let delivery = new PromptDelivery();
delivery.settledByPaneGoing = (id) => server?.status(id);
const GAMMA_HEARTBEAT_MS = 500;
async function send(id: string, message: PaneMessage): Promise<boolean> {
	console.log("sent", id, JSON.stringify(message));
	delivery.queue(id, message);
	if (id === gamma.id && message.type === "prompt" && message.id) {
		const promptId = message.id;
		setTimeout(() => {
			if (existsSync(join(dir, "held"))) return;
			if (existsSync(join(dir, "gone"))) {
				delivery.ended(id, gamma.id, undefined, true);
				return;
			}
			delivery.take(id, gamma.id);
			if (existsSync(join(dir, "compacting")))
				delivery.reported(id, [{ id: promptId, outcome: "refused", reason: "compacting" }]);
			else {
				const outcome = busy() ? "queued" : "taken";
				if (outcome === "taken") append(gamma.sessionFile, "user", message.text);
				else queued.push(promptId);
				delivery.reported(id, [{ id: promptId, outcome }]);
			}
			server?.status(id);
		}, GAMMA_HEARTBEAT_MS);
	}
	return true;
}

const store = new RemoteStore(join(dir, "remote.json"));
server = await startRemoteServer(
	{
		store,
		webDir: join(import.meta.dirname, "../daemon/remote/web"),
		listInstances: () => {
			const listed = panes.map((p) =>
				p === gamma ? listedGamma() : p === alpha && replying ? { ...p, activity: "working" as const } : p,
			);
			return existsSync(join(dir, "moved"))
				? listed.map((p) => (p.id === "pi-alpha" ? { ...p, id: "pi-alpha-2", pane: "pi-alpha-2" } : p))
				: listed;
		},
		send,
		launch: () => undefined,
		startSession: () => "pi-new",
		claimStart: () => ({ ok: true, id: "pi-new" }),
		paneStarting: () => {},
		startFailed: () => {},
		terminalOpen: () => !existsSync(join(dir, "closed")),
		report: (id) =>
			id === gamma.id && !quit
				? {
						models: [],
						outcomes: [],
						commands: [
							{ name: "compact", source: "builtin" },
							{
								name: "skill:review",
								source: "skill",
								description: "Review the current changes",
								skill: {
									id: "a".repeat(64),
									scope: "project",
									origin: "local",
									source: "local",
									path: "/fixture/project/.pi/skills/review/SKILL.md",
								},
							},
							{
								name: "skill:plan",
								source: "skill",
								description: "Plan implementation",
								skill: {
									id: "b".repeat(64),
									scope: "user",
									origin: "package",
									source: "npm:fixture-skills",
									path: "/fixture/packages/skills/plan/SKILL.md",
								},
							},
						],
					}
				: undefined,
		statusLine: async () => {
			if (existsSync(join(dir, "slow"))) await sleep(5000);
			return {};
		},
		outcomes: (id) => delivery.outcomes(id),
		lifetime: () => delivery.lifetime,
		answer: (id, waiting) => delivery.answer(id, waiting, id === gamma.id && !quit),
		renameInstance: () => true,
		setPinned: () => true,
		deleteInstance: () => true,
	},
	0,
);
const { code, secret } = store.createCode();
console.log(`http://127.0.0.1:${server.port}/  pairing code ${code}  QR link /#pair=${secret}  dir ${dir}`);

const TRANSCRIPT_LAG_MS = 2000;
async function streamReply(): Promise<void> {
	const path = alpha.sessionFile;
	replying = true;
	const text = "Let me look at the files in this directory first.";
	const call = { id: `call-${entries}`, name: "bash", summary: "ls" };
	const words = text.split(" ");
	for (let n = 1; n <= words.length; n++) {
		server?.live("pi-alpha", { text: words.slice(0, n).join(" "), tools: [] });
		await sleep(300);
	}
	server?.live("pi-alpha", { text, tools: [{ ...call, running: false }] });
	const line = nextEntryLine(path, {
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id: call.id, name: call.name, arguments: { command: "ls" } },
		],
	});
	server?.live("pi-alpha", null, leaves.get(path));
	server?.live("pi-alpha", { text: "", tools: [{ ...call, running: true }] });
	await sleep(TRANSCRIPT_LAG_MS);
	appendFileSync(path, line);
	await sleep(1500);
	appendFileSync(
		path,
		nextEntryLine(path, { role: "toolResult", toolCallId: call.id, toolName: "bash", content: "a.ts" }),
	);
	server?.live("pi-alpha", null);
	replying = false;
}

setInterval(() => {
	const trigger = join(dir, "reply");
	if (!existsSync(trigger)) return;
	rmSync(trigger);
	void streamReply();
}, 500);

setInterval(() => {
	const dequeue = join(dir, "dequeue");
	if (existsSync(dequeue)) {
		rmSync(dequeue);
		delivery.reported(
			gamma.id,
			queued.splice(0).map((id) => ({ id, outcome: "lost", reason: "dequeued" })),
		);
		server?.status(gamma.id);
	}
	const restart = join(dir, "restart");
	if (existsSync(restart)) {
		rmSync(restart);
		delivery = new PromptDelivery();
		delivery.settledByPaneGoing = (id) => server?.status(id);
		server?.status(gamma.id);
	}
	if (!quit && existsSync(join(dir, "quit"))) {
		quit = true;
		delivery.ended(gamma.id, gamma.id, "quit", true);
	}
}, 500);
