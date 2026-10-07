/**
 * bluclawd's visual identity: the welcome header.
 *
 * The theme is not registered here: the `pi.themes` manifest entry in
 * `package.json` registers `themes/bluclawd.json` before pi resolves the
 * startup theme. An extension's `resources_discover` hook runs too late for
 * that (pi would already have printed "Theme not found").
 *
 * pi honours `quietStartup` before a header factory is consulted, so there is
 * nothing to check here.
 */
import { homedir } from "node:os";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { prefersReducedMotion } from "../_shared/settings.ts";
import { setSharedTheme } from "../_shared/theme.ts";
import { mascotGlyphs } from "./mascot.ts";
import { AUTO_THEME, ThemePicker, themeOptions } from "./theme-picker.ts";
import { MascotPlayer, pickEntrance, WelcomeHeader, type WelcomeHeaderInfo } from "./welcome-header.ts";

function tildePath(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

const branding: InlineExtension = {
	name: "branding",
	factory: (pi) => {
		// Persists to the same setting pi's own settings panel writes.
		pi.registerCommand("theme", {
			description: "Switch the theme (pick from a list, or /theme <name>)",
			handler: async (args, ctx) => {
				const names = ctx.ui
					.getAllThemes()
					.map((entry) => entry.name)
					.sort();
				const openSettings = () =>
					SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
				const save = async (setting: string) => {
					try {
						const settings = openSettings();
						settings.setTheme(setting);
						await settings.flush();
					} catch {
						ctx.ui.notify(
							`Theme "${setting}" applied for this session; could not save it to settings.`,
							"warning",
						);
						return;
					}
					ctx.ui.notify(`Theme set to "${setting}".`, "info");
				};
				// A light/dark pair resolves by the terminal's appearance, which the system theme is generated from.
				const resolve = (setting: string | undefined): string => {
					const pair = setting?.split("/");
					if (pair?.length !== 2) return setting ?? "system";
					return ctx.ui.getTheme("system")?.appearance === "light" ? pair[0] : pair[1];
				};
				// Shown as an instance, which pi does not write to settings.
				const show = (setting: string | undefined) => {
					const theme = ctx.ui.getTheme(resolve(setting));
					if (theme) ctx.ui.setTheme(theme);
				};

				let name = args.trim();
				if (!name) {
					if (!ctx.hasUI) {
						ctx.ui.notify(`Usage: /theme <name>. Available: ${names.join(", ")}`, "info");
						return;
					}
					let saved: string | undefined;
					try {
						saved = openSettings().getThemeSetting();
					} catch {
						// Unreadable settings: taken as pi's default, the system theme.
					}
					const chosen = await ctx.ui.custom<string | undefined>(
						(tui, theme, _keybindings, done) =>
							new ThemePicker(
								theme,
								themeOptions(names),
								saved ?? "system",
								(value) => {
									show(value);
									tui.requestRender();
								},
								done,
							),
					);
					if (chosen === undefined) {
						// Back to the saved theme; a plain name goes by name so pi tracks it as the setting again.
						if (saved && !saved.includes("/")) ctx.ui.setTheme(saved);
						else show(saved);
						return;
					}
					if (chosen === AUTO_THEME) {
						// pi cannot apply a pair from an extension: show its theme now, and pi resolves the
						// pair from settings at the next start.
						show(chosen);
						await save(chosen);
						return;
					}
					name = chosen;
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
				await save(name);
			},
		});

		pi.on("session_start", (event, ctx) => {
			// Other components read this shared reference because pi's theme
			// singleton isn't part of the public package export.
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
