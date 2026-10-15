/**
 * Desktop notifications, as Claude Code's terminal ones: a session that stops working (done,
 * needs input, failed) is announced with OSC 777 (OSC 99 on kitty), and the terminal decides
 * whether to show it.
 *
 * Every agent view session is a tmux pane and most are shown in no terminal, so each pane watches
 * every session through the daemon, and only the pane a terminal shows writes the notification,
 * through tmux's passthrough (on in the private server's config). With several terminals
 * attached, the one showing the pane named first does, so each change is announced once. With no
 * terminal attached nothing is: remote control's phone push covers that. A pi outside tmux
 * notifies when its own turn settles.
 */

import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { OrchestratorClient } from "../../daemon/orchestrator-client.ts";
import { Notifier } from "../../daemon/remote/notifier.ts";
import { type RemoteSession, remoteSessions } from "../../daemon/remote/sessions.ts";
import { Tmux, type TmuxClient } from "../../daemon/tmux.ts";

const POLL_MS = 2000;

const clean = (text: string) => text.replace(/[\r\n]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "");

/** The escape that asks the terminal for a notification; `inTmux` wraps it for tmux's passthrough. */
export function notificationEscape(title: string, body: string, termname: string, inTmux: boolean): string {
	const t = clean(title).replaceAll(";", ",");
	const b = clean(body);
	const sequence = termname.includes("kitty")
		? `\x1b]99;i=1:d=0;${t}\x1b\\\x1b]99;i=1:p=body;${b}\x1b\\`
		: `\x1b]777;notify;${t};${b}\x07`;
	return inTmux ? `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\` : sequence;
}

/** The client showing `pane`, if no client shows a pane named before it. */
export function shownBy(clients: TmuxClient[], pane: string): TmuxClient | undefined {
	const first = [...clients].sort((a, b) => (a.session < b.session ? -1 : a.session > b.session ? 1 : 0))[0];
	return first?.session === pane ? first : undefined;
}

export interface WatchDeps {
	pane: string;
	sessions: () => Promise<RemoteSession[]>;
	clients: () => TmuxClient[];
	write: (text: string) => void;
}

/** One poll: what changed since the last, announced if this pane is the one to. */
export function watchSessions(deps: WatchDeps): () => Promise<void> {
	const notifier = new Notifier();
	return async () => {
		try {
			const notes = notifier.observe(await deps.sessions());
			if (notes.length === 0) return;
			const client = shownBy(deps.clients(), deps.pane);
			if (!client) return;
			for (const note of notes) deps.write(notificationEscape(note.title, note.body, client.termname, true));
		} catch {
			// no daemon or no tmux server: the next poll tries again
		}
	};
}

function factory(pi: ExtensionAPI): void {
	let stop: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		stop?.();
		stop = undefined;
		const pane = Tmux.currentPane();
		if (!ctx.hasUI || !pane) return;
		const client = new OrchestratorClient();
		const tmux = new Tmux();
		const tick = watchSessions({
			pane,
			sessions: async () => remoteSessions(await client.list()),
			clients: () => tmux.clients(),
			write: (text) => process.stdout.write(text),
		});
		let polling = false;
		const timer = setInterval(() => {
			if (polling) return;
			polling = true;
			void tick().finally(() => {
				polling = false;
			});
		}, POLL_MS);
		stop = () => clearInterval(timer);
	});

	pi.on("session_shutdown", () => {
		stop?.();
		stop = undefined;
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!ctx.hasUI || Tmux.currentPane()) return;
		const termname = process.env.KITTY_WINDOW_ID ? "xterm-kitty" : (process.env.TERM ?? "");
		process.stdout.write(notificationEscape("pi", "Ready for input", termname, Boolean(process.env.TMUX)));
	});
}

const notificationsExtension: InlineExtension = { name: "notifications", factory };
export default notificationsExtension.factory;
