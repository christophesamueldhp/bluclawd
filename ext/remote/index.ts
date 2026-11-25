import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PaneMessage, PaneReport, RefusedReason } from "../../daemon/ipc/protocol.ts";
import { currentDaemonBuildId, OrchestratorClient, type RemoteResult } from "../../daemon/orchestrator-client.ts";
import { piCommand, Tmux } from "../../daemon/tmux.ts";
import { holdTui } from "../_shared/hold-tui.ts";
import { remotePort } from "../_shared/settings.ts";
import { startupSettings } from "../_shared/startup-settings.ts";
import { timed } from "../_shared/timing.ts";
import type { ProjectTrust } from "../_shared/trust-badge.ts";
import { promptContent, promptOptions } from "../agent-view/index.ts";
import { TRUST_CHANGED } from "../permissions/index.ts";
import { remoteSkillPrompt } from "../skills/prompt.ts";
import { autostartDeps, autostartOn, autostartStatus, repointPlistForNextLogin, toggleAutostart } from "./autostart.ts";
import { coalescingSender, forwardLive, type LiveForwarder } from "./live.ts";
import { pairingText } from "./message.ts";
import { PromptOutcomes } from "./outcomes.ts";
import {
	applyPaneMessage,
	buildReport,
	legacyCommandNotice,
	paneTasks,
	pistatuslinePaths,
	submitCommand,
	watchTasks,
} from "./report.ts";
import { EnableNeeded, serve, tailscaleInfo } from "./tailscale.ts";

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function upToDateDaemon(): Promise<{ client: OrchestratorClient } | { error: string }> {
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
	for (;;) {
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
			const confirmed = await ctx.ui.confirm(
				"Remove all phones?",
				"Each will have to pair again. Any pending pairing will end.",
			);
			if (!confirmed) continue;
			await client.remote({ action: "revoke_all" });
			ctx.ui.notify("Removed all phones", "info");
			return;
		}
		const device = devices[labels.indexOf(picked)];
		if (!device) continue;
		const confirmed = await ctx.ui.confirm(
			`Remove ${device.name}?`,
			"It will have to pair again. Any pending pairing will end.",
		);
		if (!confirmed) continue;
		await client.remote({ action: "revoke", deviceId: device.id });
		ctx.ui.notify(`Removed ${device.name}`, "info");
	}
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

const LEGACY_SUBCOMMANDS = ["pair", "devices", "autostart"];
const HUNG_TMUX_TIMEOUT_MS = 2000;

const PAIR = "Pair a new phone";
const OFF = "Turn off remote control";
export const USAGE =
	"Usage: /remote-control, with no arguments: it turns remote control on, then offers a menu " +
	"(pair a new phone, paired phones, start at login, turn off)";

async function menu(client: OrchestratorClient, status: RemoteResult, ctx: ExtensionCommandContext): Promise<void> {
	const deps = autostartDeps();
	const startAtLogin = deps.platform === "darwin" ? `Start at login: ${autostartOn(deps) ? "on" : "off"}` : undefined;
	const phones = `Paired phones (${status.devices.length})…`;
	const items = [PAIR, phones, ...(startAtLogin ? [startAtLogin] : []), OFF];
	const picked = await ctx.ui.select("Remote control is on", items);
	if (picked === undefined) return;
	if (picked === PAIR) await show(status.listening ? await client.remote({ action: "pair" }) : status, ctx);
	else if (picked === phones) await devices(client, ctx);
	else if (picked === OFF) await turnOff(client, status.port, ctx);
	else if (picked === startAtLogin) await toggleStartAtLogin(ctx);
}

function repointPlistForNextLoginQuietly(): void {
	try {
		repointPlistForNextLogin(autostartDeps());
	} catch {}
}

function isThePanesPi(pane: string | undefined, ctx: Pick<ExtensionContext, "mode">): pane is string {
	return !!pane && ctx.mode === "tui";
}

function liveForwarder(pi: ExtensionAPI, pane: string | undefined): LiveForwarder {
	if (!pane) return forwardLive(pi, () => {});
	const client = new OrchestratorClient();
	return forwardLive(
		pi,
		coalescingSender((snapshot, entryId) => client.remoteLive(pane, snapshot, entryId)),
	);
}

function factory(pi: ExtensionAPI): void {
	const pane = Tmux.currentPane();
	const live = liveForwarder(pi, pane);
	const commandKeys = new Tmux(undefined, undefined, { timeoutMs: HUNG_TMUX_TIMEOUT_MS });
	const client = new OrchestratorClient();
	let reports = Promise.resolve();
	let session: ExtensionContext | undefined;
	let tui: ReturnType<typeof holdTui> | undefined;
	let watched = false;
	let reportedTasks = "";
	let unwatchTasks: (() => void) | undefined;
	let statusline: PaneReport["pistatusline"];
	const report = (ctx: ExtensionContext, notice?: string, trustOf?: () => ProjectTrust): void => {
		if (!isThePanesPi(pane, ctx)) return;
		session = ctx;
		const next = {
			...buildReport(ctx, pi, trustOf),
			...(statusline ? { pistatusline: statusline } : {}),
			...(notice ? { notice: { text: notice, at: Date.now() } } : {}),
			outcomes: outcomes.list(),
		};
		reportedTasks = JSON.stringify(next.tasks);
		reports = reports.then(() => client.remoteReport(pane, next)).catch(() => {});
	};
	const outcomes = new PromptOutcomes(
		pi,
		(look) => pi.events.on("bluclawd:remote-watched", look),
		(ctx) => {
			report(ctx);
			return reports;
		},
	);
	const reportIfWatched = (ctx: ExtensionContext): void => {
		if (watched) report(ctx);
		else if (isThePanesPi(pane, ctx)) session = ctx;
	};
	pi.on("session_start", (event, ctx) => {
		if (isThePanesPi(pane, ctx)) {
			tui = holdTui(ctx, "remote:tui");
			statusline = pistatuslinePaths(pi);
			unwatchTasks?.();
			unwatchTasks = watchTasks(() => {
				const ctx = session;
				if (!ctx || !watched) return;
				if (JSON.stringify(paneTasks(ctx.sessionManager.getSessionId())) !== reportedTasks) report(ctx);
			});
		}
		report(ctx, undefined, () => startupSettings(event, ctx).settings.getDefaultProjectTrust());
	});
	pi.on("model_select", (_event, ctx) => reportIfWatched(ctx));
	pi.on("thinking_level_select", (_event, ctx) => reportIfWatched(ctx));
	pi.on("turn_end", (_event, ctx) => reportIfWatched(ctx));
	pi.on("session_compact", (_event, ctx) => reportIfWatched(ctx));
	pi.events.on("bluclawd:pane-message", (data) => {
		const ctx = session;
		if (!ctx || !pane) return;
		const message = data as PaneMessage;
		const id = message.type === "prompt" || message.type === "command" ? message.id : undefined;
		const refuse = (id: string, reason: RefusedReason) => {
			outcomes.refused(id, reason);
			report(ctx);
		};
		if (id && (message.type === "prompt" || message.type === "command")) {
			const reason = outcomes.refusal(message, ctx.sessionManager.getSessionFile());
			if (reason) return refuse(id, reason);
		}
		if (message.type === "prompt") {
			let text: string;
			try {
				text = remoteSkillPrompt(message.text, message.skills ?? [], pi.getCommands());
			} catch {
				if (id) refuse(id, "invalid_skills");
				else report(ctx, "Selected skills are unavailable. Select them again.");
				return;
			}
			const prepared = { ...message, text };
			const content = promptContent(prepared);
			if (id) outcomes.sent(id, content);
			pi.sendUserMessage(content, promptOptions(prepared));
		} else if (message.type === "command") {
			const enter = () => commandKeys.sendKeys(pane, ["Enter"]);
			const reason = submitCommand(message.text, ctx, tui?.(), enter);
			if (!id) {
				if (reason) report(ctx, legacyCommandNotice(reason));
			} else if (reason) refuse(id, reason);
			else {
				outcomes.slashCommandTaken(id);
				report(ctx);
			}
		} else applyPaneMessage(message, ctx, pi, () => report(ctx));
	});
	pi.events.on("bluclawd:remote-watched", (data) => {
		const opened = data === true && !watched;
		watched = data === true;
		live.setWatched(watched);
		if (opened && session) report(session);
	});
	pi.events.on("bluclawd:remote-want-report", () => {
		if (session) report(session);
	});
	pi.events.on(TRUST_CHANGED, () => {
		if (session) reportIfWatched(session);
	});
	pi.on("session_shutdown", () => {
		live.reset();
		unwatchTasks?.();
		unwatchTasks = undefined;
		session = undefined;
	});

	pi.registerCommand("remote-control", {
		description: "Control your sessions from your phone",
		handler: async (args, ctx) => {
			const sub = args.trim();
			if (sub && !LEGACY_SUBCOMMANDS.includes(sub)) {
				ctx.ui.notify(USAGE, "warning");
				return;
			}
			if (sub === "autostart") return await toggleStartAtLogin(ctx);
			repointPlistForNextLoginQuietly();
			const started = await upToDateDaemon();
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
export default timed("remote", remoteExtension.factory);
