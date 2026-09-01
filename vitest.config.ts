import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../vitest.base.ts";

/**
 * Aliases pi's own package names to source, same reason
 * `packages/coding-agent/vitest.config.ts` does: the npm workspace symlink for
 * `@earendil-works/pi-coding-agent` resolves through `package.json`'s `main`,
 * which points at `dist/` — testing that would mean testing yesterday's build,
 * not the pi this branch is currently merged onto.
 */
export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			testTimeout: 30000,
			env: { PI_OFFLINE: "1" },
			unstubEnvs: true,
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			silent: "passed-only",
			include: ["bluclawd/test/**/*.test.ts"],
		},
		resolve: {
			alias: [{ find: /^@earendil-works\/pi-coding-agent$/, replacement: workspaceSourcePaths.codingAgentIndex }],
		},
	}),
);
