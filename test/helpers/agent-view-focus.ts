import { stripAnsi } from "../../daemon/ansi.ts";
import type { AgentView } from "../../ext/agent-view/agent-view.ts";

/** Agent view's focused row as drawn, the line on its highlight (#373737 in a dark theme), as plain text. */
export function focusedLine(view: AgentView): string | undefined {
	const line = view.render(100).find((l) => l.includes("\x1b[48;2;55;55;55m"));
	return line && stripAnsi(line);
}
