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
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { setSharedTheme } from "../_shared/theme.ts";
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

const branding: InlineExtension = {
	name: "branding",
	factory: (pi) => {
		pi.on("session_start", (_event, ctx) => {
			// Populate the shared theme reference other components in this layer
			// (fleet-view and friends) import instead of reaching into pi's own
			// theme singleton, which isn't part of the public package export.
			setSharedTheme(ctx.ui.theme);

			// The header factory hands us the TUI; that is the only handle an
			// extension gets for repainting once the mascot finishes decoding.
			ctx.ui.setHeader((tui, theme) => {
				void preloadMascot(() => tui.requestRender());
				const info = (): WelcomeBoxInfo => {
					const rows: string[] = [];
					if (mascotLines) rows.push(...mascotLines);
					rows.push("");
					rows.push(theme.bold(theme.fg("accent", "Welcome to bluclawd")));
					rows.push(theme.fg("dim", "/help for commands · @ for files · ! for bash"));
					return {
						title: `bluclawd v${VERSION}`,
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
