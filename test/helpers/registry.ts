import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerSupervisor, type TmuxProbe } from "../../daemon/supervisor.ts";
import type { InstanceRecord } from "../../daemon/types.ts";

export const paneUp: TmuxProbe = { hasSession: () => true, hangUpAsQuit: () => {} };

export function testRegistry(
	dir: string = mkdtempSync(join(tmpdir(), "bluclawd-registry-")),
	now: () => number = () => Date.now(),
	tmux: TmuxProbe = paneUp,
): ServerSupervisor {
	return new ServerSupervisor({ now, tmux, dir });
}

export function savedRow(
	supervisor: ServerSupervisor,
	options: Parameters<ServerSupervisor["saveInstance"]>[0],
): InstanceRecord {
	const row = supervisor.saveInstance(options);
	if (!row) throw new Error(`saveInstance kept no row: ${options.sessionFile} was deleted`);
	return row;
}
