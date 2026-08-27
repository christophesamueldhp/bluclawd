/**
 * `/help` — a categorised command surface.
 *
 * pi has no `/help`; its command list lives only in the autocomplete popup,
 * which is fine for finding a command you can already name and useless for
 * discovering one you cannot. This groups everything by what you are trying to
 * DO, merging pi's built-ins with extension commands, prompt templates and
 * skills into one list — someone looking for `/rewind` does not know or care
 * that it comes from an extension while `/fork` is built in.
 *
 * `pi.getCommands()` deliberately does NOT include built-ins (see
 * `agent-session.ts`), so the built-in table is imported from pi directly and
 * merged here. Extension commands that shadow a built-in name are collapsed,
 * keeping the built-in's description.
 */

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { APP_NAME } from "../../../packages/coding-agent/src/config.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../../packages/coding-agent/src/core/slash-commands.ts";
import { categorizeCommands } from "./categories.ts";

interface HelpEntry {
	name: string;
	description: string;
}

interface HelpData {
	version: string;
	appName: string;
	commands: HelpEntry[];
	templates: HelpEntry[];
	skills: HelpEntry[];
}

function pad(name: string, width: number): string {
	return name.length >= width ? name : name.padEnd(width);
}

const help: InlineExtension = {
	name: "help",
	factory: (pi) => {
		pi.registerEntryRenderer<HelpData>("bluclawd:help", (entry, _options, theme) => {
			const data = entry.data;
			if (!data) return new Text("", 1, 0);

			const lines: string[] = [theme.bold(`${data.appName} v${data.version} — help`), ""];
			lines.push(theme.bold("Input"));
			lines.push(
				`  ${theme.fg("accent", "! <cmd>")}   ${theme.fg("dim", "run bash, output added to context (!! to keep it out)")}`,
			);
			lines.push(
				`  ${theme.fg("accent", "@ <path>")}  ${theme.fg("dim", "mention a file (Tab autocompletes paths)")}`,
			);
			lines.push(
				`  ${theme.fg("accent", "# <note>")}  ${theme.fg("dim", "save a quick note to persistent memory")}`,
			);
			lines.push(
				`  ${theme.fg("accent", "Alt+M")}     ${theme.fg("dim", "cycle permission modes — /hotkeys lists every shortcut")}`,
			);

			const width =
				Math.max(
					1,
					...data.commands.map((c) => c.name.length),
					...data.templates.map((c) => c.name.length),
					...data.skills.map((c) => c.name.length),
				) + 2;
			const described = new Map(data.commands.map((c) => [c.name, c.description]));

			for (const group of categorizeCommands(data.commands.map((c) => c.name))) {
				lines.push("", theme.bold(group.title));
				for (const name of group.names) {
					lines.push(`  /${pad(name, width)} ${theme.fg("dim", described.get(name) ?? "")}`);
				}
			}

			for (const [title, entries] of [
				["Prompt templates", data.templates],
				["Skills", data.skills],
			] as const) {
				if (entries.length === 0) continue;
				lines.push("", theme.bold(title));
				for (const entry of entries) {
					lines.push(`  /${pad(entry.name, width)} ${theme.fg("dim", entry.description)}`);
				}
			}

			const container = new Container();
			container.addChild(new Spacer(1));
			container.addChild(new Text(lines.join("\n"), 1, 0));
			return container;
		});

		pi.registerCommand("help", {
			description: "Show help and available commands",
			handler: async () => {
				const registered = pi.getCommands();
				const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((c) => c.name));

				const commands: HelpEntry[] = BUILTIN_SLASH_COMMANDS.map((c) => ({
					name: c.name,
					description: c.description,
				}));
				for (const command of registered) {
					if (command.source !== "extension" || builtinNames.has(command.name)) continue;
					commands.push({ name: command.name, description: command.description ?? "" });
				}

				const pick = (source: string): HelpEntry[] =>
					registered
						.filter((c) => c.source === source)
						.map((c) => ({ name: c.name, description: c.description ?? "" }));

				pi.appendEntry<HelpData>("bluclawd:help", {
					version: VERSION,
					appName: APP_NAME,
					commands,
					templates: pick("prompt"),
					skills: pick("skill"),
				});
			},
		});
	},
};

export default help;
