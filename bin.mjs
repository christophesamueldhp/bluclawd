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

/**
 * Default `tuiMode` to "fullscreen" for a user who hasn't chosen either mode.
 *
 * `tuiMode` is read once at TUI construction, before any extension factory
 * runs (`interactive-mode.ts`: `options.tuiMode ?? settingsManager.getTuiMode()`),
 * so there is no `session_start` hook late enough to flip it — the CLI flag is
 * the only lever a wrapper can reach. `--tui-mode` is documented as a
 * per-run override, not a persisted write, so this never stomps a choice the
 * user saved via `/settings`: we only inject the flag when neither the
 * command line nor settings.json already names a mode.
 */
async function withDefaultTuiMode(argv) {
	if (argv.includes("--tui-mode")) return argv;
	try {
		const { SettingsManager } = await import("../packages/coding-agent/src/index.ts");
		const configured = SettingsManager.create(process.cwd()).getGlobalSettings().tuiMode;
		if (configured) return argv;
	} catch {
		return argv; // settings unreadable: let pi resolve its own default
	}
	return [...argv, "--tui-mode", "fullscreen"];
}

const { main } = await import("../packages/coding-agent/src/index.ts");
const { bluclawdExtensions } = await import("./ext/index.ts");

const argv = await withDefaultTuiMode(translateArgs(process.argv.slice(2)));
await main(argv, { extensionFactories: bluclawdExtensions() });
