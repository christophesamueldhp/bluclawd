#!/usr/bin/env node
/**
 * Run bluclawd without a separate `pi install` — for trying it out or for
 * local development against a checkout of this repo. `pi install <path>`
 * (this repo's real distribution path) doesn't use this file at all; it
 * loads each `ext/<name>/index.ts` per `package.json`'s `pi.extensions`
 * manifest.
 *
 * Identity is plain pi — no rebrand, no PI_PACKAGE_DIR override — the point
 * of this repo is to run as an add-on to a stock pi install, not a fork of
 * it. `main(argv, { extensionFactories })` is pi's own documented embedder
 * entry; `@earendil-works/pi-coding-agent` must be resolvable (installed
 * globally or as a devDependency here) for this to import.
 *
 * Output flags.
 *
 * `--output-format` is a pure alias for pi's own `--mode`, so it is translated
 * here — the wrapper is the only place an extension-based layer can touch argv,
 * since pi parses these before any extension loads.
 *
 * `--input-format` and `--json-schema` are NOT translated: they change how main
 * reads stdin and what it prints instead of running, neither of which a wrapper
 * can reach. They fail loudly rather than being accepted and ignored.
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
