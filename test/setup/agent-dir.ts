/**
 * Assigned rather than stubbed, because `unstubEnvs` would restore the
 * real one after the first test.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const agentDir = mkdtempSync(join(tmpdir(), "bluclawd-test-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

afterAll(() => {
	rmSync(agentDir, { recursive: true, force: true });
});
