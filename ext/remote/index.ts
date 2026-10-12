/**
 * `/remote-control`: control every agent-view session from a phone, as Claude Code's Remote
 * Control does. The daemon serves the phone (daemon/remote/); this command is its switch, shows
 * how to pair, and manages paired devices.
 */
import type { ExtensionAPI, ExtensionCommandContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { remotePort } from "../_shared/settings.ts";
import { currentDaemonBuildId, OrchestratorClient, type RemoteResult } from "../agent-view/orchestrator-client.ts";
import { pairingText } from "./message.ts";
import { serve, tailscaleInfo } from "./tailscale.ts";

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
				'Set "remote": { "port": <port> } in settings for another port, then run /remote-control twice.',
			"error",
		);
		return;
	}
	if (!result.code || !result.expiresAt) return;
	const pairing = (url: string) => pairingText(url, result.code ?? "", result.expiresAt ?? 0);
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
			"Tailscale is not connected: open the Tailscale app and log in (or run `tailscale up`), then /remote-control pair",
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
			ctx.ui.notify(`tailscale serve failed: ${message(error)}`, "error");
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

async function devices(client: OrchestratorClient, ctx: ExtensionCommandContext): Promise<void> {
	const { devices } = await client.remote({ action: "devices" });
	if (devices.length === 0) {
		ctx.ui.notify("No paired devices. /remote-control pair shows a code.", "info");
		return;
	}
	const labels = devices.map(
		(d, i) =>
			`${i + 1}. ${d.name} · paired ${new Date(d.createdAt).toLocaleDateString(undefined, { dateStyle: "medium" })}` +
			(d.lastUsedAt
				? ` · last used ${new Date(d.lastUsedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
				: ""),
	);
	const picked = await ctx.ui.select("Paired devices (enter revokes)", labels);
	if (picked === undefined) return;
	const device = devices[labels.indexOf(picked)];
	if (!device || !(await ctx.ui.confirm(`Revoke ${device.name}?`, "It will have to pair again."))) return;
	await client.remote({ action: "revoke", deviceId: device.id });
	ctx.ui.notify(`Revoked ${device.name}`, "info");
}

function factory(pi: ExtensionAPI): void {
	pi.registerCommand("remote-control", {
		description: "Control sessions from your phone: on/off, pair, devices",
		handler: async (args, ctx) => {
			const sub = args.trim();
			if (sub && sub !== "pair" && sub !== "devices") {
				ctx.ui.notify("Usage: /remote-control [pair | devices]", "warning");
				return;
			}
			const started = await daemon();
			if ("error" in started) {
				ctx.ui.notify(started.error, "error");
				return;
			}
			const { client } = started;
			try {
				if (sub === "devices") return await devices(client, ctx);
				const status = await client.remote({ action: "status" });
				if (sub === "pair") {
					if (!status.enabled) {
						ctx.ui.notify("Remote control is off: run /remote-control to turn it on", "info");
						return;
					}
					return await show(await client.remote({ action: "pair" }), ctx);
				}
				if (status.enabled) {
					await client.remote({ action: "off" });
					const tailscale = await tailscaleInfo(status.port);
					ctx.ui.notify(
						tailscale.serve === "ours" && tailscale.dnsName
							? `Remote control is off (tailscale serve still proxies https://${tailscale.dnsName} to the port; \`tailscale serve --https=443 off\` removes it)`
							: "Remote control is off",
						"info",
					);
					return;
				}
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
