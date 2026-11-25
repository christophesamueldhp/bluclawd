import { homedir } from "node:os";
import type { ExtensionContext, InlineExtension, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { mascotGlyphs } from "../_shared/mascot.ts";
import { prefersReducedMotion } from "../_shared/settings.ts";
import { startupSettings } from "../_shared/startup-settings.ts";
import { timed } from "../_shared/timing.ts";
import { AUTO_THEME, ThemePicker, themeOptions } from "./theme-picker.ts";
import { MascotPlayer, pickEntrance, WelcomeHeader, type WelcomeHeaderInfo } from "./welcome-header.ts";

function tildePath(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function readReducedMotion(event: SessionStartEvent, ctx: ExtensionContext): boolean {
	try {
		return prefersReducedMotion(startupSettings(event, ctx).settings);
	} catch {
		return false;
	}
}

const branding: InlineExtension = {
	name: "branding",
	factory: (pi) => {
		let stopFollowing: (() => void) | undefined;
		/** The terminal's last light/dark report, since pi's own stops updating once a theme is shown from here. */
		let reportedScheme: "dark" | "light" | undefined;

		pi.registerCommand("theme", {
			description: "Switch the theme (pick from a list, or /theme <name>)",
			handler: async (args, ctx) => {
				const names = ctx.ui
					.getAllThemes()
					.map((entry) => entry.name)
					.sort();
				const openSettings = () =>
					SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
				const readSavedTheme = (): string | undefined => {
					try {
						return openSettings().getThemeSetting();
					} catch {
						return undefined;
					}
				};
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
					return (reportedScheme ?? ctx.ui.getTheme("system")?.appearance) === "light" ? pair[0] : pair[1];
				};
				// Shown as an instance, which pi does not write to settings.
				const show = (setting: string | undefined) => {
					const theme = ctx.ui.getTheme(resolve(setting));
					if (theme) ctx.ui.setTheme(theme);
				};
				// pi follows a pair itself only when it applied it from settings, and any theme shown from here
				// stops that until the next start. In between, this extension follows the terminal's light/dark reports.
				const follow = (tui: TUI, setting: string) => {
					stopFollowing?.();
					const [light, dark] = setting.split("/");
					const off = tui.onTerminalColorSchemeChange((scheme) => {
						reportedScheme = scheme;
						const theme = ctx.ui.getTheme(scheme === "light" ? light : dark);
						if (!theme) return;
						ctx.ui.setTheme(theme);
						tui.requestRender();
					});
					tui.setTerminalColorSchemeNotifications(true);
					stopFollowing = () => {
						off();
						tui.setTerminalColorSchemeNotifications(false);
						stopFollowing = undefined;
					};
				};

				let name = args.trim();
				if (!name) {
					if (!ctx.hasUI) {
						ctx.ui.notify(`Usage: /theme <name>. Available: ${names.join(", ")}`, "info");
						return;
					}
					const saved = readSavedTheme();
					let pickerTui: TUI | undefined;
					const chosen = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
						pickerTui = tui;
						return new ThemePicker(
							theme,
							themeOptions(names),
							saved ?? "system",
							(value) => {
								show(value);
								tui.requestRender();
							},
							done,
						);
					});
					if (chosen === undefined) {
						// Back to the saved theme; a plain name goes by name so pi tracks it as the setting again.
						if (saved && !saved.includes("/")) ctx.ui.setTheme(saved);
						else show(saved);
						if (saved?.includes("/") && pickerTui) follow(pickerTui, saved);
						return;
					}
					if (chosen === AUTO_THEME) {
						// pi cannot apply a pair from an extension, so show its theme now and follow the terminal,
						// and pi resolves the pair from settings at the next start.
						show(chosen);
						if (pickerTui) follow(pickerTui, chosen);
						await save(chosen);
						return;
					}
					name = chosen;
				}
				if (!names.includes(name)) {
					ctx.ui.notify(`Unknown theme "${name}". Available: ${names.join(", ")}`, "error");
					return;
				}
				stopFollowing?.();
				const result = ctx.ui.setTheme(name);
				if (!result.success) {
					ctx.ui.notify(`Failed to load theme "${name}": ${result.error ?? "unknown error"}`, "error");
					return;
				}
				await save(name);
			},
		});

		pi.on("session_shutdown", () => stopFollowing?.());

		pi.on("session_start", (event, ctx) => {
			ctx.ui.setHeader((tui, theme) => {
				const glyphs = mascotGlyphs();
				const reducedMotion = readReducedMotion(event, ctx);
				const entrance = pickEntrance({
					fullscreen: tui.mode === "fullscreen",
					reducedMotion,
					startup: event.reason === "startup",
				});
				// Each frame redraws the header, taking the terminal's cursor up there and back; the
				// editor draws its own cursor meanwhile.
				const hideCursor = entrance !== undefined && tui.getShowHardwareCursor();
				if (hideCursor) tui.setShowHardwareCursor(false);
				const player = new MascotPlayer(
					entrance,
					() => tui.requestRender(),
					undefined,
					hideCursor ? () => tui.setShowHardwareCursor(true) : undefined,
				);
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

export default timed("branding", branding.factory);
