// Headless probe: run every bluclawd extension factory against a recording stub
// and report what each one registers. Verifies wiring without TUI timing races.
import { bluclawdExtensions } from "../ext/index.ts";

const noop = () => {};
const rec: Record<string, { commands: string[]; tools: string[]; shortcuts: number; events: string[] }> = {};

for (const ext of bluclawdExtensions()) {
	const r = {
		commands: [] as string[],
		tools: [] as string[],
		shortcuts: 0,
		events: [] as string[],
	};
	rec[ext.name] = r;
	const pi: any = new Proxy(
		{
			registerCommand: (name: string) => r.commands.push(name),
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
		ext.factory(pi);
	} catch (err) {
		console.log(`  ${ext.name}: FACTORY THREW — ${err instanceof Error ? err.message : String(err)}`);
	}
}

let commands = 0;
for (const [name, r] of Object.entries(rec)) {
	commands += r.commands.length;
	console.log(
		`${name.padEnd(16)} commands=[${r.commands.join(" ") || "-"}] tools=[${r.tools.join(" ") || "-"}] shortcuts=${r.shortcuts} events=${r.events.length}`,
	);
}
console.log(`\nTOTAL: ${Object.keys(rec).length} extensions, ${commands} commands`);
