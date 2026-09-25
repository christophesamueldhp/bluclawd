/**
 * bluclawd's visual identity: the welcome header.
 *
 * The theme itself is not registered here. `package.json`'s `pi.themes`
 * manifest entry makes `themes/bluclawd.json` a package resource, which pi
 * registers before it resolves the configured theme at startup — so
 * `"theme": "bluclawd"` in settings.json is the startup theme with no fallback
 * notice. (An extension's `resources_discover` hook runs too late for that:
 * pi has already applied the startup theme and printed "Theme not found".)
 * `setHeader` replaces the startup banner with Claude Code's header: the
 * mascot beside name, model and cwd (welcome-header.ts).
 *
 * `quietStartup` is pi's own setting and pi honours it before a header factory
 * is consulted, so there is nothing to check here.
 */
import { homedir } from "node:os";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { prefersReducedMotion } from "../_shared/settings.ts";
import { setSharedTheme } from "../_shared/theme.ts";
import { mascotGlyphs } from "./mascot.ts";
import { MascotPlayer, pickEntrance, WelcomeHeader, type WelcomeHeaderInfo } from "./welcome-header.ts";

function tildePath(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

const branding: InlineExtension = {
	name: "branding",
	factory: (pi) => {
		// Claude Code's /theme: pick from every theme pi knows (built-in, custom,
		// package) and persist the choice, the same setting pi's own settings
		// panel writes.
		pi.registerCommand("theme", {
			description: "Switch the theme (pick from a list, or /theme <name>)",
			handler: async (args, ctx) => {
				const names = ctx.ui
					.getAllThemes()
					.map((entry) => entry.name)
					.sort();
				let name = args.trim();
				if (!name) {
					if (!ctx.hasUI) {
						ctx.ui.notify(`Usage: /theme <name>. Available: ${names.join(", ")}`, "info");
						return;
					}
					name = (await ctx.ui.select("Theme", names)) ?? "";
					if (!name) return;
				}
				if (!names.includes(name)) {
					ctx.ui.notify(`Unknown theme "${name}". Available: ${names.join(", ")}`, "error");
					return;
				}
				const result = ctx.ui.setTheme(name);
				if (!result.success) {
					ctx.ui.notify(`Failed to load theme "${name}": ${result.error ?? "unknown error"}`, "error");
					return;
				}
				try {
					const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
					settings.setTheme(name);
					await settings.flush();
				} catch {
					ctx.ui.notify(`Theme "${name}" applied for this session; could not save it to settings.`, "warning");
					return;
				}
				ctx.ui.notify(`Theme set to "${name}".`, "info");
			},
		});

		pi.on("session_start", (event, ctx) => {
			// Populate the shared theme reference other components in this layer
			// (fleet-view and friends) import instead of reaching into pi's own
			// theme singleton, which isn't part of the public package export.
			setSharedTheme(ctx.ui.theme);

			ctx.ui.setHeader((tui, theme) => {
				const glyphs = mascotGlyphs();
				let reducedMotion = false;
				try {
					const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
					reducedMotion = prefersReducedMotion(settings);
				} catch {
					// Unreadable settings: animate as by default.
				}
				const entrance = pickEntrance({
					fullscreen: tui.mode === "fullscreen",
					reducedMotion,
					startup: event.reason === "startup",
				});
				const player = new MascotPlayer(entrance, () => tui.requestRender());
				const info = (): WelcomeHeaderInfo => {
					const model = ctx.model;
					const level = pi.getThinkingLevel();
					return {
						version: VERSION,
						model: model ? (model.name ?? model.id) : undefined,
						effort: model?.reasoning && level !== "off" ? level : undefined,
						provider: model ? ctx.modelRegistry.getProviderDisplayName(model.provider) : undefined,
						cwd: tildePath(ctx.cwd),
					};
				};
				return new WelcomeHeader(glyphs, player, info, (text) => theme.fg("muted", text)) as Component & {
					dispose?(): void;
				};
			});
		});
	},
};

export default branding.factory;
