// Headless probe: run every bluclawd extension factory against a recording stub
// and report what each one registers. Verifies wiring without TUI timing races.
//
// `recordExtensions` is also used by test/registration.test.ts to assert this
// shape in CI rather than relying on someone reading the printed table.
import { bluclawdExtensions } from "../ext/index.ts";

export interface ExtensionRecord {
	commands: string[];
	tools: string[];
	shortcuts: number;
	events: string[];
	error?: string;
}

export function recordExtensions(): Record<string, ExtensionRecord> {
	const noop = () => {};
	const rec: Record<string, ExtensionRecord> = {};

	for (const ext of bluclawdExtensions()) {
		// InlineExtension is a union: a bare factory, or a named wrapper around one.
		const name = typeof ext === "function" ? ext.name || "(anonymous)" : ext.name;
		const factory = typeof ext === "function" ? ext : ext.factory;
		const r: ExtensionRecord = { commands: [], tools: [], shortcuts: 0, events: [] };
		rec[name] = r;
		const pi: any = new Proxy(
			{
				registerCommand: (cmdName: string) => r.commands.push(cmdName),
				registerTool: (t: any) => r.tools.push(t?.name ?? "?"),
				registerShortcut: () => {
					r.shortcuts++;
				},
				on: (event: string) => r.events.push(event),
				registerEntryRenderer: noop,
				registerMessageRenderer: noop,
				registerMarkdownTransformer: noop,
				registerFlag: noop,
				registerProvider: noop,
				appendEntry: noop,
				getFlag: () => undefined,
				exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
			},
			{ get: (t: any, p: string) => (p in t ? t[p] : noop) },
		);
		try {
			factory(pi);
		} catch (err) {
			r.error = err instanceof Error ? err.message : String(err);
		}
	}

	return rec;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const rec = recordExtensions();
	let commands = 0;
	for (const [name, r] of Object.entries(rec)) {
		commands += r.commands.length;
		if (r.error) {
			console.log(`  ${name}: FACTORY THREW — ${r.error}`);
			continue;
		}
		console.log(
			`${name.padEnd(16)} commands=[${r.commands.join(" ") || "-"}] tools=[${r.tools.join(" ") || "-"}] shortcuts=${r.shortcuts} events=${r.events.length}`,
		);
	}
	console.log(`\nTOTAL: ${Object.keys(rec).length} extensions, ${commands} commands`);
}
