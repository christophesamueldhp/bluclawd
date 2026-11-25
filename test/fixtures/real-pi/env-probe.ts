import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUN_PANE_ENV } from "../../../daemon/tmux.ts";

export default function envProbe(): void {
	const runDir = process.env[RUN_PANE_ENV];
	if (runDir) writeFileSync(join(runDir, "env-probe"), process.env.BC_TEST_SECRET ? "set" : "unset");
}
