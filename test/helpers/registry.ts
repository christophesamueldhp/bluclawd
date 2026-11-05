import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerSupervisor, type TmuxProbe } from "../../daemon/supervisor.ts";

/** Every pane asked about is still up. */
export const paneUp: TmuxProbe = { hasSession: () => true, end: () => {} };

/** A registry on a temp storage dir of its own, on the real clock and with every pane up unless given others. */
export function testRegistry(
	dir: string = mkdtempSync(join(tmpdir(), "bluclawd-registry-")),
	now: () => number = () => Date.now(),
	tmux: TmuxProbe = paneUp,
): ServerSupervisor {
	return new ServerSupervisor({ now, tmux, dir });
}
