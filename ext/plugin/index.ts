/**
 * `/plugin` — Claude Code's name for managing installed packages, over pi's
 * own package manager (`DefaultPackageManager`, the same code behind
 * `pi install` / `pi remove` / `pi update`).
 *
 *   /plugin                      list configured packages and where they are installed
 *   /plugin install <source> [-l] add and install (npm name, git URL, or local path); -l = project scope
 *   /plugin remove <source> [-l]  uninstall and drop from settings
 *   /plugin update [source]       update one package, or every git/npm package
 *
 * Manage-only on purpose — there is no browse/marketplace surface. A package
 * executes arbitrary code at load time with no signing or consent step, so
 * naming a source here is the same explicit act as typing `pi install`; a
 * catalogue you can click through would widen trust without adding any
 * safeguard. Changes take effect after `/reload`.
 */
import type { ExtensionCommandContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { DefaultPackageManager, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

function packageManagerFor(ctx: ExtensionCommandContext): DefaultPackageManager {
	return new DefaultPackageManager({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		settingsManager: SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() }),
	});
}

/** Exported pure for tests. */
export function formatPackageList(
	packages: { source: string; scope: "user" | "project"; filtered: boolean; installedPath?: string }[],
): string[] {
	if (packages.length === 0) {
		return ["No packages configured.", "Add one with /plugin install <npm name | git URL | path>."];
	}
	const lines = ["Packages:"];
	for (const p of packages) {
		const state = p.installedPath ? p.installedPath : "not installed — /plugin update to fetch";
		const notes = [p.scope === "project" ? "project" : "user", p.filtered ? "filtered by pi config" : ""].filter(
			Boolean,
		);
		lines.push(`  ${p.source}  (${notes.join(", ")})`);
		lines.push(`      ${state}`);
	}
	return lines;
}

const USAGE = "Usage: /plugin [install <source> [-l] | remove <source> [-l] | update [source]]";

const plugin: InlineExtension = {
	name: "plugin",
	factory: (pi) => {
		pi.registerCommand("plugin", {
			description: "List, install, remove, or update packages (pi install/remove/update)",
			handler: async (args, ctx) => {
				const words = args.trim().split(/\s+/).filter(Boolean);
				const verb = words[0] ?? "list";
				const local = words.includes("-l") || words.includes("--project");
				const source = words.slice(1).find((w) => w !== "-l" && w !== "--project");

				let pm: DefaultPackageManager;
				try {
					pm = packageManagerFor(ctx);
				} catch (error) {
					ctx.ui.notify(
						`Cannot open the package manager: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					return;
				}
				pm.setProgressCallback((event) => {
					ctx.ui.setStatus("plugin", event.message ?? `${event.action} ${event.source}…`);
				});
				const done = (message: string, level: "info" | "error" = "info") => {
					ctx.ui.setStatus("plugin", undefined);
					ctx.ui.notify(message, level);
				};

				try {
					switch (verb) {
						case "list":
							done(formatPackageList(pm.listConfiguredPackages()).join("\n"));
							return;
						case "install":
							if (!source) return done(USAGE, "error");
							if (local && !ctx.isProjectTrusted())
								return done("Project is not trusted — cannot add a project-scoped package.", "error");
							ctx.ui.notify(`Installing ${source}…`, "info");
							await pm.installAndPersist(source, { local });
							done(`Installed ${source}. Run /reload to load it.`);
							return;
						case "remove":
							if (!source) return done(USAGE, "error");
							if (!(await pm.removeAndPersist(source, { local })))
								return done(`${source} is not configured.`, "error");
							done(`Removed ${source}. Run /reload to unload it.`);
							return;
						case "update":
							ctx.ui.notify(source ? `Updating ${source}…` : "Updating packages…", "info");
							await pm.update(source);
							done(
								source ? `Updated ${source}. Run /reload to apply.` : "Packages updated. Run /reload to apply.",
							);
							return;
						default:
							done(USAGE, "error");
					}
				} catch (error) {
					done(`/plugin ${verb} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			},
		});
	},
};

export default plugin.factory;
