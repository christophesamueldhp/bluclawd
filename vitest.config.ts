import { defineConfig } from "vitest/config";
import { readinessMs } from "./test/helpers/heartbeats.ts";

const pollThenTeardownMs = readinessMs + readinessMs;

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: pollThenTeardownMs,
		hookTimeout: pollThenTeardownMs,
		expect: { poll: { timeout: readinessMs } },
		env: { PI_OFFLINE: "1" },
		unstubEnvs: true,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot", "json"],
		outputFile: { json: ".vitest/last-run.json" },
		silent: "passed-only",
		include: ["test/**/*.test.ts"],
		setupFiles: ["test/setup/agent-dir.ts", "test/setup/faux-exhaustion.ts"],
	},
});
