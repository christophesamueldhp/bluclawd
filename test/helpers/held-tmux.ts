import type { TmuxProbe } from "../../daemon/supervisor.ts";

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
		hangUpAsQuit: () => {},
	};
	const answer = () => {
		for (const [name, resolve] of pending) {
			pending.delete(name);
			resolve();
		}
	};
	return { tmux, pending, asked, blocking, answer };
}
