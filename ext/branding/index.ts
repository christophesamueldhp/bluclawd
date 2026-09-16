/**
 * bluclawd's visual identity: the welcome banner.
 *
 * The theme itself is not registered here. `package.json`'s `pi.themes`
 * manifest entry makes `themes/bluclawd.json` a package resource, which pi
 * registers before it resolves the configured theme at startup — so
 * `"theme": "bluclawd"` in settings.json is the startup theme with no fallback
 * notice. (An extension's `resources_discover` hook runs too late for that:
 * pi has already applied the startup theme and printed "Theme not found".)
 * `setHeader` replaces the startup banner with the two-pane box and the mascot.
 *
 * The mascot is decoded asynchronously (photon) and the banner renders without
 * it until it is ready — a missing or undecodable PNG degrades to a text-only
 * box rather than blocking startup or crashing.
 *
 * `quietStartup` is pi's own setting and pi honours it before a header factory
 * is consulted, so there is nothing to check here.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import {
	getAgentDir,
	loadProjectContextFiles,
	SessionManager,
	SettingsManager,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { setSharedTheme } from "../_shared/theme.ts";
import { renderPixelArt } from "./pixel-art.ts";
import { WelcomeBox, type WelcomeBoxInfo } from "./welcome-box.ts";
import { type WelcomeInfo, welcomeSections } from "./welcome-info.ts";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Fixed display parameters for the mascot. mascot.png is pixel art on a 20×15
 * logical grid, so sampling at width 20 reproduces every source pixel. Terminal
 * cells are ~2.3× taller than wide, which would show the native grid ~14% too
 * tall, so columns 2 and 17 render doubled — they are the only mirrored pair
 * that is flat in every row, so doubling them changes no feature's size.
 */
const MASCOT_WIDTH_CELLS = 20;
const MASCOT_DOUBLE_COLUMNS = [2, 17];

let mascotLines: string[] | null = null;

async function preloadMascot(requestRender: () => void): Promise<void> {
	try {
		const bytes = readFileSync(join(here, "mascot.png"));
		mascotLines = await renderPixelArt(bytes, MASCOT_WIDTH_CELLS, MASCOT_DOUBLE_COLUMNS);
	} catch {
		mascotLines = null; // banner renders text-only
	}
	// The header factory reads `mascotLines` on every render, so a repaint is all
	// that is needed once decoding finishes.
	requestRender();
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

		/** Filled in asynchronously after startup; the banner renders without it first. */
		let recentSessions: WelcomeInfo["recentSessions"] = [];

		/** What the banner's sidebar shows, read live so a model switch shows on the next render. */
		function welcomeInfo(
			ctx: ExtensionContext,
			contextFiles: number,
			recent: WelcomeInfo["recentSessions"],
		): WelcomeInfo {
			let systemPromptTokens: number | undefined;
			try {
				systemPromptTokens = Math.ceil(ctx.getSystemPrompt().length / 4) || undefined;
			} catch {
				// A retired context (session switch) throws; the size just goes blank.
			}
			const commands = pi.getCommands();
			return {
				model: ctx.model ? { name: ctx.model.name ?? ctx.model.id, provider: ctx.model.provider } : undefined,
				loaded: {
					contextFiles,
					skills: commands.filter((command) => command.source === "skill").length,
					tools: pi.getAllTools().length,
					promptTemplates: commands.filter((command) => command.source === "prompt").length,
				},
				systemPromptTokens,
				recentSessions: recent,
				tips: [
					"Ask a question to start — it reads and edits files itself.",
					"/mode switches how much it asks before acting.",
					"# saves a note to memory; /memory shows what is saved.",
				],
			};
		}

		/** The three newest other sessions started in this directory. */
		async function loadRecentSessions(ctx: ExtensionContext): Promise<WelcomeInfo["recentSessions"]> {
			try {
				const current = ctx.sessionManager.getSessionFile();
				const sessions = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir());
				return sessions
					.filter((session) => session.path !== current && session.messageCount > 0)
					.sort((a, b) => b.modified.getTime() - a.modified.getTime())
					.slice(0, 3)
					.map((session) => ({ title: session.name ?? session.firstMessage, modified: session.modified }));
			} catch {
				return [];
			}
		}

		pi.on("session_start", (_event, ctx) => {
			// Populate the shared theme reference other components in this layer
			// (fleet-view and friends) import instead of reaching into pi's own
			// theme singleton, which isn't part of the public package export.
			setSharedTheme(ctx.ui.theme);

			// The header factory hands us the TUI; that is the only handle an
			// extension gets for repainting once the mascot finishes decoding.
			ctx.ui.setHeader((tui, theme) => {
				void preloadMascot(() => tui.requestRender());
				void loadRecentSessions(ctx).then((sessions) => {
					recentSessions = sessions;
					tui.requestRender();
				});
				// The same discovery pi ran for this session's AGENTS.md / CLAUDE.md files;
				// extensions get no read access to the loaded list at startup.
				let contextFiles = 0;
				try {
					contextFiles = loadProjectContextFiles({ cwd: ctx.cwd, agentDir: getAgentDir() }).length;
				} catch {
					// Unreadable files: the count is left out.
				}
				const info = (): WelcomeBoxInfo => {
					const rows: string[] = [];
					if (mascotLines) rows.push(...mascotLines);
					rows.push("");
					rows.push(theme.bold(theme.fg("accent", "Welcome to bluclawd")));
					rows.push(theme.fg("dim", "/help for commands · @ for files · ! for bash"));
					return {
						title: `bluclawd v${VERSION}`,
						rows,
						sidebar: welcomeSections(welcomeInfo(ctx, contextFiles, recentSessions), theme, Date.now()),
					};
				};
				return new WelcomeBox(info) as Component & { dispose?(): void };
			});
		});
	},
};

export default branding.factory;
