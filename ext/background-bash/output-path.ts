import { homedir } from "node:os";
import { join } from "node:path";

export function taskOutputRoot(home = homedir()): string {
	return join(home, ".bluclawd-task-output");
}
