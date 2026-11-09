import type { TmuxProbe } from "../../daemon/supervisor.ts";

/** A tmux whose has-session answers only when the test says, each pane as `up` has it. `asked` records
 *  every name asked about, `blocking` those asked with a blocking call. */
export function heldTmux(up: Set<string>) {
	const pending = new Map<string, () => void>();
	const asked: string[] = [];
	const blocking: string[] = [];
	const tmux: TmuxProbe = {
		hasSession: (name) => {
			asked.push(name);
			blocking.push(name);
			return up.has(name);
		},
		hasSessionAsync: (name) => {
			asked.push(name);
			return new Promise((resolve) => pending.set(name, () => resolve(up.has(name))));
		},
		end: () => {},
	};
	const answer = () => {
		for (const [name, resolve] of pending) {
			pending.delete(name);
			resolve();
		}
	};
	return { tmux, pending, asked, blocking, answer };
}
