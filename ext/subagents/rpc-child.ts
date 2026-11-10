/**
 * The one bluclawd extension an RPC run's pi loads (`-ne -e`): none of the orchestrator's, so the run has no
 * `subagent` or `schedule_wakeup` of its own. Its tools are fixed by a plain `--tools` list; this closes the shell
 * that pi's RPC `bash` command runs outside that list.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function rpcChild(pi: ExtensionAPI): void {
	pi.on("user_bash", () => ({
		result: { output: "Refused: a subagent run has no shell.", exitCode: 1, cancelled: false, truncated: false },
	}));
}
