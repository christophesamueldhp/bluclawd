#!/usr/bin/env node
/**
 * bluclawd entry point.
 *
 * Everything bluclawd changes about pi happens here or in `ext/` — pi's own
 * source is untouched, so `git merge upstream/main` on this branch is a
 * fast-forward.
 *
 *  1. PI_PACKAGE_DIR points pi's config loader at this directory, so identity
 *     comes from our package.json's `piConfig` (name, config dir) rather than
 *     pi's. This is pi's documented override, not a patch.
 *  2. PI_SKIP_VERSION_CHECK stops pi phoning pi.dev for its own updates — the
 *     fork's debrand, expressed as an env var pi already honours instead of as
 *     a source edit that deletes upstream code.
 *  3. main(argv, { extensionFactories }) is pi's embedder entry; the bluclawd
 *     feature layer is passed in as ordinary inline extensions.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(fileURLToPath(import.meta.url));
process.env.PI_PACKAGE_DIR = packageDir;
process.env.PI_SKIP_VERSION_CHECK ??= "1";

/**
 * Claude Code-compatible output flags.
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

const { main } = await import("../packages/coding-agent/src/index.ts");
const { bluclawdExtensions } = await import("./ext/index.ts");

await main(translateArgs(process.argv.slice(2)), { extensionFactories: bluclawdExtensions() });
