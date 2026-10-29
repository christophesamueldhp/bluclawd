import { defineConfig } from "vitest/config";

/**
 * Tests run against pi's real published package (a peer dependency,
 * installed separately) rather than any monorepo source alias — this repo
 * has no sibling `packages/` to alias into.
 */
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		env: { PI_OFFLINE: "1" },
		unstubEnvs: true,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot", "json"],
		// Keeps the last local run's failures readable after its output is gone, so a flake can be named.
		outputFile: { json: ".vitest/last-run.json" },
		silent: "passed-only",
		include: ["test/**/*.test.ts"],
		setupFiles: ["test/setup/agent-dir.ts"],
	},
});
