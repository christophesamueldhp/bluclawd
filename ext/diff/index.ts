/**
 * `/diff` — review the working-tree diff in a focused overlay.
 *
 * The viewer is a full Component shown through `ctx.ui.custom({ overlay: true })`,
 * pi's own mechanism for an extension that needs the screen and the keyboard.
 * It closes by calling the `done` callback pi hands the factory, which restores
 * focus to the editor.
 *
 * Runs git itself rather than going through a tool, so nothing enters the model's
 * context: `/diff` is for the human reading the screen.
 */

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { execWithIo } from "../_shared/exec.ts";
import { setSharedTheme } from "../_shared/theme.ts";
import { DiffView } from "./diff-view.ts";
import { parseUnifiedDiff } from "./git-diff.ts";

const IN_REPO_TIMEOUT_MS = 5_000;
const DIFF_TIMEOUT_MS = 15_000;

const diff: InlineExtension = {
	name: "diff",
	factory: (pi) => {
		pi.registerCommand("diff", {
			description: "Review the working-tree diff",
			handler: async (args, ctx) => {
				const cwd = ctx.cwd;
				const inRepo = await execWithIo("git", ["rev-parse", "--is-inside-work-tree"], {
					cwd,
					timeout: IN_REPO_TIMEOUT_MS,
				});
				if (inRepo.code !== 0) {
					ctx.ui.notify("/diff needs a git repository.", "warning");
					return;
				}

				const ref = args.trim();
				const diffArgs = ref ? ["diff", ref] : ["diff", "HEAD"];
				const result = await execWithIo("git", ["--no-optional-locks", ...diffArgs], {
					cwd,
					timeout: DIFF_TIMEOUT_MS,
				});
				if (result.code !== 0) {
					ctx.ui.notify(
						`git ${diffArgs.join(" ")} failed: ${result.stderr.trim() || `exit ${result.code}`}`,
						"error",
					);
					return;
				}

				const files = parseUnifiedDiff(result.stdout);
				if (!ref) {
					// `git diff HEAD` omits untracked files; list them so new work is visible.
					const untracked = await execWithIo(
						"git",
						["--no-optional-locks", "ls-files", "--others", "--exclude-standard"],
						{ cwd, timeout: IN_REPO_TIMEOUT_MS },
					);
					for (const path of untracked.stdout
						.split("\n")
						.map((line) => line.trim())
						.filter(Boolean)) {
						if (files.some((file) => file.path === path)) continue;
						// --no-index against /dev/null yields a normal unified diff of the whole
						// file, so a new file shows its contents instead of an empty entry. It
						// exits 1 when there are differences — the expected case here.
						const added = await execWithIo(
							"git",
							["--no-optional-locks", "diff", "--no-index", "--", "/dev/null", path],
							{ cwd, timeout: DIFF_TIMEOUT_MS },
						);
						const parsed = parseUnifiedDiff(added.stdout);
						const entry = parsed.find((file) => file.path.endsWith(path)) ?? parsed[0];
						files.push(
							entry
								? { ...entry, path, status: "added" }
								: { path, status: "added", diff: "", insertions: 0, deletions: 0 },
						);
					}
				}

				if (files.length === 0) {
					ctx.ui.notify(ref ? `No changes against ${ref}.` : "No changes in the working tree.", "info");
					return;
				}

				// pi's package loader gives each top-level extension file its own module
				// instance (loadExtensionModule's moduleCache: false), so branding's
				// setSharedTheme call never reaches diff's separately-loaded copy of
				// _shared/theme.ts — set it here, right before the component that reads
				// it is built, which also means a mid-session theme switch is picked up.
				setSharedTheme(ctx.ui.theme);
				await ctx.ui.custom<void>(
					(tui, _theme, _keybindings, done) =>
						new DiffView({
							ui: tui,
							files,
							label: ref || "working tree",
							onClose: () => done(undefined),
						}) as Component & { dispose?(): void },
					{ overlay: true, overlayOptions: { width: "90%", maxHeight: "90%" } },
				);
			},
		});
	},
};

export default diff.factory;
