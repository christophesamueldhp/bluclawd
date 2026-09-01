/**
 * bluclawd's visual identity: the theme and the welcome banner.
 *
 * Two pi mechanisms carry it. `resources_discover` contributes this layer's
 * `themes/` directory to pi's theme search path, so `"theme": "bluclawd"` in
 * settings.json resolves without the theme file living inside pi. `setHeader`
 * replaces the startup banner with the two-pane box and the mascot.
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
import { SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { APP_NAME } from "../../../packages/coding-agent/src/config.ts";
import { renderPixelArt } from "./pixel-art.ts";
import { WelcomeBox, type WelcomeBoxInfo } from "./welcome-box.ts";

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

/** How many macrotask ticks to wait for extension theme discovery before giving up. */
const THEME_APPLY_ATTEMPTS = 20;

/**
 * Apply the configured theme once it is discoverable.
 *
 * A no-op when the user configured a theme pi already had (pi applied it at
 * startup) or one nobody provides. Cosmetic by nature: every failure is
 * swallowed rather than allowed to disturb session start.
 */
function applyConfiguredTheme(ctx: ExtensionContext, attemptsLeft: number): void {
	let configured: string | undefined;
	try {
		configured = SettingsManager.create(ctx.cwd, undefined, {
			projectTrusted: ctx.isProjectTrusted(),
		}).getThemeSetting();
	} catch {
		return;
	}
	if (!configured) return;

	const attempt = (remaining: number): void => {
		try {
			if (ctx.ui.getAllThemes().some((entry) => entry.name === configured)) {
				ctx.ui.setTheme(configured);
				return;
			}
		} catch {
			return;
		}
		if (remaining > 0) setTimeout(() => attempt(remaining - 1), 0).unref?.();
	};
	attempt(attemptsLeft);
}

const branding: InlineExtension = {
	name: "branding",
	factory: (pi) => {
		pi.on("resources_discover", () => ({ themePaths: [join(here, "..", "..", "themes")] }));

		pi.on("session_start", (_event, ctx) => {
			// pi resolves the configured theme during startup, BEFORE extensions have
			// contributed their theme paths — so a theme shipped here can never be the
			// startup theme, and pi falls back to dark with a "Theme not found" notice.
			// Re-apply once discovery has run. The ordering of session_start against
			// resource discovery is not guaranteed, so this retries on the macrotask
			// queue until the theme shows up, with a hard cap rather than a spin.
			applyConfiguredTheme(ctx, THEME_APPLY_ATTEMPTS);

			// The header factory hands us the TUI; that is the only handle an
			// extension gets for repainting once the mascot finishes decoding.
			ctx.ui.setHeader((tui, theme) => {
				void preloadMascot(() => tui.requestRender());
				const info = (): WelcomeBoxInfo => {
					const rows: string[] = [];
					if (mascotLines) rows.push(...mascotLines);
					rows.push("");
					rows.push(theme.bold(theme.fg("accent", `Welcome to ${APP_NAME}`)));
					rows.push(theme.fg("dim", "/help for commands · @ for files · ! for bash"));
					return {
						title: `${APP_NAME} v${VERSION}`,
						rows,
						sidebar: [
							{
								heading: "Tips for getting started",
								lines: [
									theme.fg("dim", "Ask a question to start — it reads and edits files itself."),
									theme.fg("dim", "/mode switches how much it asks before acting."),
									theme.fg("dim", "# saves a note to memory; /memory shows what is saved."),
								],
							},
						],
					};
				};
				return new WelcomeBox(info) as Component & { dispose?(): void };
			});
		});
	},
};

export default branding.factory;
