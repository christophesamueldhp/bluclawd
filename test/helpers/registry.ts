import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerSupervisor, type TmuxProbe } from "../../daemon/supervisor.ts";

/** Every pane asked about is still up. */
export const paneUp: TmuxProbe = { hasSession: () => true };

/** A registry on a temp storage dir of its own, on the real clock unless given one. */
export function testRegistry(
	dir: string = mkdtempSync(join(tmpdir(), "bluclawd-registry-")),
	now: () => number = () => Date.now(),
): ServerSupervisor {
	return new ServerSupervisor({ now, tmux: paneUp, dir });
}
