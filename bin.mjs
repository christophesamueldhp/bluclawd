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

const { main } = await import("../packages/coding-agent/src/index.ts");
const { bluclawdExtensions } = await import("./ext/index.ts");

await main(process.argv.slice(2), { extensionFactories: bluclawdExtensions() });
