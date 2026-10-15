/**
 * `/remote-control`: control every agent-view session from a phone, as Claude Code's Remote
 * Control does. The daemon serves the phone (daemon/remote/); this command turns it on and shows a
 * QR code that pairs a phone, and once it is on, a menu: pair another phone, the paired phones,
 * starting the daemon at login (autostart.ts), turning it off. In a pane,
 * it also streams the reply in progress to the phones watching the session (live.ts), reports its
 * model, usage, trust mode and slash commands, and runs the phone's model, thinking level and trust
 * mode switches, compaction, tree navigation, fork, clone and slash commands (report.ts).
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	currentDaemonBuildId,
	OrchestratorClient,
	type PaneMessage,
	type RemoteResult,
} from "../../daemon/orchestrator-client.ts";
import { piCommand, Tmux } from "../../daemon/tmux.ts";
import { holdTui } from "../_shared/hold-tui.ts";
import { remotePort } from "../_shared/settings.ts";
import { TRUST_CHANGED } from "../permissions/index.ts";
import { autostartDeps, autostartOn, autostartStatus, refreshAutostart, toggleAutostart } from "./autostart.ts";
import { LiveForwarder, latestOnly } from "./live.ts";
import { pairingText } from "./message.ts";
import { applyPaneMessage, buildReport, navigate, submitCommand } from "./report.ts";
import { EnableNeeded, serve, tailscaleInfo } from "./tailscale.ts";

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A daemon started from older code has no remote control: replace it, as agent view does. */
async function daemon(): Promise<{ client: OrchestratorClient } | { error: string }> {
	const client = new OrchestratorClient();
	if (!(await client.ensureDaemon())) return { error: "The agent daemon is not running and could not be started" };
	const info = await client.getDaemonInfo();
	if (info.buildId !== currentDaemonBuildId()) {
		const result = await client.restartDaemon();
		if (!result.restarted) {
			return {
				error: `The agent daemon is out of date and could not be restarted: ${result.reason ?? "unknown reason"}`,
			};
		}
	}
	return { client };
}

async function show(result: RemoteResult, ctx: ExtensionCommandContext): Promise<void> {
	if (!result.listening) {
		ctx.ui.notify(
			`Remote control could not listen on 127.0.0.1:${result.port}: ${result.listenError ?? "unknown error"}. ` +
				'Set "remote": { "port": <port> } in settings for another port, then turn remote control off and on again from /remote-control.',
			"error",
		);
		return;
	}
	if (!result.code || !result.secret || !result.expiresAt) return;
	const pairing = (url: string) =>
		[
			pairingText(url, result.secret ?? "", result.code ?? "", result.expiresAt ?? 0),
			autostartStatus(autostartDeps()),
		]
			.filter(Boolean)
			.join("\n");
	const tailscale = await tailscaleInfo(result.port);
	if (!tailscale.installed) {
		const code = `${result.code.slice(0, 3)} ${result.code.slice(3)}`;
		ctx.ui.notify(
			"Tailscale is not installed, so your phone cannot reach this Mac: https://tailscale.com/download\n" +
				`You can try the app in a browser on this Mac at http://127.0.0.1:${result.port} with the code ${code}.`,
			"warning",
		);
		return;
	}
	if (!tailscale.dnsName) {
		ctx.ui.notify(
			"Tailscale is not connected: open the Tailscale app and log in (or run `tailscale up`), then run /remote-control again",
			"warning",
		);
		return;
	}
	const url = `https://${tailscale.dnsName}`;
	if (tailscale.serve !== "ours") {
		const ok =
			tailscale.serve === "other"
				? await ctx.ui.confirm(
						`Replace your tailnet's ${url} handler?`,
						`${url} currently proxies / somewhere else. \`tailscale serve --bg ${result.port}\` will replace it with 127.0.0.1:${result.port} on this Mac.`,
					)
				: await ctx.ui.confirm(
						"Expose remote control on your tailnet?",
						`Runs \`tailscale serve --bg ${result.port}\`: ${url} proxies to 127.0.0.1:${result.port} on this Mac, reachable only from your tailnet.`,
					);
		if (!ok) {
			ctx.ui.notify(
				`Not exposed. Run \`tailscale serve --bg ${result.port}\` yourself, then:\n${pairing(url)}`,
				"info",
			);
			return;
		}
		try {
			await serve(result.port);
		} catch (error) {
			if (error instanceof EnableNeeded) ctx.ui.notify(error.message, "warning");
			else ctx.ui.notify(`tailscale serve failed: ${message(error)}`, "error");
			return;
		}
	}
	if (tailscale.funnel) {
		ctx.ui.notify(
			`Tailscale Funnel is on for ${url}: remote control is reachable from the public internet, not only your tailnet. Turn it off with \`tailscale funnel --https=443 off\`.`,
			"warning",
		);
	}
	ctx.ui.notify(pairing(url), "info");
}

const REMOVE_ALL = "Remove all phones";

async function devices(client: OrchestratorClient, ctx: ExtensionCommandContext): Promise<void> {
	const { devices } = await client.remote({ action: "devices" });
	if (devices.length === 0) {
		ctx.ui.notify("No paired phones: pair one from /remote-control", "info");
		return;
	}
	const labels = devices.map(
		(d, i) =>
			`${i + 1}. ${d.name} · paired ${new Date(d.createdAt).toLocaleDateString(undefined, { dateStyle: "medium" })}` +
			(d.lastUsedAt
				? ` · last used ${new Date(d.lastUsedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
				: ""),
	);
	const picked = await ctx.ui.select("Paired phones (enter removes one)", [...labels, REMOVE_ALL]);
	if (picked === undefined) return;
	if (picked === REMOVE_ALL) {
		const phones = `${devices.length} phone${devices.length === 1 ? "" : "s"}`;
		if (!(await ctx.ui.confirm(`Remove all ${phones}?`, "Each will have to pair again."))) return;
		for (const device of devices) await client.remote({ action: "revoke", deviceId: device.id });
		ctx.ui.notify(`Removed ${phones}`, "info");
		return;
	}
	const device = devices[labels.indexOf(picked)];
	if (!device || !(await ctx.ui.confirm(`Remove ${device.name}?`, "It will have to pair again."))) return;
	await client.remote({ action: "revoke", deviceId: device.id });
	ctx.ui.notify(`Removed ${device.name}`, "info");
}

async function toggleStartAtLogin(ctx: ExtensionCommandContext): Promise<void> {
	const deps = autostartDeps();
	try {
		ctx.ui.notify(toggleAutostart(deps), "info");
	} catch (error) {
		ctx.ui.notify(`Starting at login: ${message(error)}`, "error");
	}
	// Unloading ends a daemon launchd started; loading has launchd start one.
	if (deps.platform === "darwin" && !autostartOn(deps)) await new OrchestratorClient().ensureDaemon();
}

async function turnOff(client: OrchestratorClient, port: number, ctx: ExtensionCommandContext): Promise<void> {
	const ok = await ctx.ui.confirm(
		"Turn off remote control?",
		"Paired phones stay paired, but cannot reach this Mac until you turn it on again.",
	);
	if (!ok) return;
	await client.remote({ action: "off" });
	const tailscale = await tailscaleInfo(port);
	ctx.ui.notify(
		tailscale.serve === "ours" && tailscale.dnsName
			? `Remote control is off (tailscale serve still proxies https://${tailscale.dnsName} to the port; \`tailscale serve --https=443 off\` removes it)`
			: "Remote control is off",
		"info",
	);
}

const PAIR = "Pair a new phone";
const OFF = "Turn off remote control";
export const USAGE =
	"Usage: /remote-control, with no arguments: it turns remote control on, then offers a menu " +
	"(pair a new phone, paired phones, start at login, turn off)";

/** Once on, `/remote-control` asks what to do rather than turning off at a stray enter. */
async function menu(client: OrchestratorClient, status: RemoteResult, ctx: ExtensionCommandContext): Promise<void> {
	const deps = autostartDeps();
	const startAtLogin = deps.platform === "darwin" ? `Start at login: ${autostartOn(deps) ? "on" : "off"}` : undefined;
	const phones = `Paired phones (${status.devices.length})…`;
	const items = [PAIR, phones, ...(startAtLogin ? [startAtLogin] : []), OFF];
	const picked = await ctx.ui.select("Remote control is on", items);
	if (picked === undefined) return;
	// Not listening, the daemon gives no code: show() says why instead.
	if (picked === PAIR) await show(status.listening ? await client.remote({ action: "pair" }) : status, ctx);
	else if (picked === phones) await devices(client, ctx);
	else if (picked === OFF) await turnOff(client, status.port, ctx);
	else if (picked === startAtLogin) await toggleStartAtLogin(ctx);
}

function liveForwarder(pane: string): LiveForwarder {
	const client = new OrchestratorClient();
	return new LiveForwarder(latestOnly((snapshot) => client.remoteLive(pane, snapshot)));
}

function factory(pi: ExtensionAPI): void {
	// Only a pane registers (agent view), so only a pane can be watched.
	const pane = Tmux.currentPane();
	const live = pane ? liveForwarder(pane) : undefined;
	/** Presses Enter in this pane for a phone's slash command; a hung tmux must not hold up pi. */
	const commandKeys = new Tmux(undefined, undefined, { timeoutMs: 2000 });
	const client = new OrchestratorClient();
	let reports = Promise.resolve();
	/** The session's context, for the bus, whose events carry none. */
	let session: ExtensionContext | undefined;
	/** The session's TUI, which the phone's slash commands check has its prompt focused. */
	let tui: ReturnType<typeof holdTui> | undefined;
	let watched = false;
	/** The phone's tree, fork and clone sent as `/remote-control` and not yet run. */
	const dispatched = new Set<string>();
	/** `notice`: what the pane could not do for the phone, which this report alone carries. */
	const report = (ctx: ExtensionContext, notice?: string): void => {
		// As agent view registers: a `pi -p` run inside the pane must not report as the pane.
		if (!pane || ctx.mode !== "tui") return;
		session = ctx;
		const next = { ...buildReport(ctx, pi), ...(notice ? { notice: { text: notice, at: Date.now() } } : {}) };
		reports = reports.then(() => client.remoteReport(pane, next)).catch(() => {});
	};
	pi.on("session_start", (_event, ctx) => {
		if (pane && ctx.mode === "tui") tui = holdTui(ctx, "remote:tui");
		report(ctx);
	});
	pi.on("model_select", (_event, ctx) => report(ctx));
	pi.on("thinking_level_select", (_event, ctx) => report(ctx));
	pi.on("turn_end", (_event, ctx) => report(ctx));
	pi.on("session_compact", (_event, ctx) => report(ctx));
	pi.events.on("bluclawd:pane-message", (data) => {
		const ctx = session;
		if (!ctx || !pane) return;
		const message = data as PaneMessage;
		if (message.type === "command") {
			const enter = () => commandKeys.sendKeys(pane, ["Enter"]);
			submitCommand(message.text, ctx, tui?.(), enter, (notice) => report(ctx, notice));
		} else applyPaneMessage(message, ctx, pi, () => report(ctx), dispatched);
	});
	pi.events.on("bluclawd:remote-watched", (data) => {
		const opened = data === true && !watched;
		watched = data === true;
		live?.setWatched(watched);
		// A restarted daemon has no report until the next turn: a phone opening the session sends it again.
		if (opened && session) report(session);
	});
	pi.events.on("bluclawd:remote-want-report", () => {
		if (session) report(session);
	});
	pi.events.on(TRUST_CHANGED, () => {
		if (session) report(session);
	});
	pi.on("message_update", (event) => live?.onMessageUpdate(event.message));
	pi.on("tool_execution_start", (event) => live?.onToolStart(event.toolCallId, event.toolName, event.args));
	pi.on("tool_execution_end", (event) => live?.onToolEnd(event.toolCallId));
	pi.on("message_end", () => live?.onMessageEnd());
	pi.on("agent_end", () => live?.onAgentEnd());
	pi.on("session_shutdown", () => {
		// As a turn's end: no timer left to send, and the phone's snapshot of ours cleared.
		live?.onAgentEnd();
		session = undefined;
	});

	pi.registerCommand("remote-control", {
		description: "Control your sessions from your phone",
		handler: async (args, ctx) => {
			const sub = args.trim();
			// The phone's tree, fork and clone (report.ts), not offered to the user: typed, they are not run.
			// The session's own context reports, not the command's.
			const refuse = (notice: string) => session && report(session, notice);
			if (dispatched.delete(sub) && (await navigate(sub, ctx, refuse))) return;
			// pair, devices and autostart: the menu's items, as the subcommands they were before it.
			if (sub && sub !== "pair" && sub !== "devices" && sub !== "autostart") {
				ctx.ui.notify(USAGE, "warning");
				return;
			}
			if (sub === "autostart") return await toggleStartAtLogin(ctx);
			// Its node may have moved since it was written, as a node upgrade does. Here, not at every
			// session start: any pi starting, a dev checkout's too, would point it at itself.
			try {
				refreshAutostart(autostartDeps());
			} catch {
				// the status says when it is out of date
			}
			const started = await daemon();
			if ("error" in started) {
				ctx.ui.notify(started.error, "error");
				return;
			}
			const { client } = started;
			try {
				if (sub === "devices") return await devices(client, ctx);
				const status = await client.remote({ action: "status", launch: { command: piCommand() } });
				if (sub === "pair") {
					if (!status.enabled) {
						ctx.ui.notify("Remote control is off: run /remote-control to turn it on", "info");
						return;
					}
					return await show(await client.remote({ action: "pair" }), ctx);
				}
				if (status.enabled) return await menu(client, status, ctx);
				const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
				await show(await client.remote({ action: "on", port: remotePort(settings) }), ctx);
			} catch (error) {
				ctx.ui.notify(`Remote control: ${message(error)}`, "error");
			}
		},
	});
}

const remoteExtension: InlineExtension = { name: "remote", factory };
export default remoteExtension.factory;
