#!/usr/bin/env node
/**
 * `--output-format` is a pure alias for pi's own `--mode`, so the wrapper translates
 * it here. pi parses these before any extension loads, so the wrapper is the only
 * place an extension-based layer can touch argv.
 */
function translateArgs(argv) {
	const out = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--output-format" && i + 1 < argv.length) {
			const format = argv[++i];
			if (format === "text") out.push("--mode", "text");
			else if (format === "stream-json") out.push("--mode", "json");
			else {
				const hint =
					format === "json"
						? "--output-format json (single result object) is not supported; use stream-json for the JSONL event stream"
						: `Invalid --output-format "${format}". Valid values: text, stream-json`;
				console.error(hint);
				process.exit(2);
			}
			continue;
		}
		if (arg === "--input-format" || arg === "--json-schema") {
			console.error(
				`${arg} is not available in this build: it needs pi's own argument parser, which an extension layer cannot reach.`,
			);
			process.exit(2);
		}
		out.push(arg);
	}
	return out;
}

const { main } = await import("@earendil-works/pi-coding-agent");
const { bluclawdExtensions } = await import("./ext/index.ts");

await main(translateArgs(process.argv.slice(2)), { extensionFactories: bluclawdExtensions() });
