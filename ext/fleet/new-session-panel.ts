import { getKeybindings, Input, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../_shared/theme.ts";

export interface NewSessionValues {
	path: string;
	model: string;
	task: string;
}

export type NewSessionKey = "submit" | "cancel" | "handled";

const LABELS = ["path", "model", "task"] as const;

/** The 3-field "New session" panel: path / model / task, with tab/arrow focus and enter=launch. */
export class NewSessionPanel {
	private readonly inputs = [new Input(), new Input(), new Input()];
	private focus = 2; // task field is focused first

	/** Fill an input and leave the cursor at the END — `Input.setValue` keeps the cursor at 0,
	 *  so continued typing would prepend; feeding the value through handleInput advances it. */
	private static fill(input: Input, value: string): void {
		input.setValue("");
		for (const ch of value) input.handleInput(ch);
	}

	/** Prefill path + model with the foreground defaults; seed the task with an optional first char. */
	open(defaults: { path: string; model: string }, seedTask = ""): void {
		NewSessionPanel.fill(this.inputs[0], defaults.path);
		NewSessionPanel.fill(this.inputs[1], defaults.model);
		NewSessionPanel.fill(this.inputs[2], seedTask);
		this.focus = 2;
	}

	reset(): void {
		for (const input of this.inputs) input.setValue("");
		this.focus = 2;
	}

	values(): NewSessionValues {
		return {
			path: this.inputs[0].getValue().trim(),
			model: this.inputs[1].getValue().trim(),
			task: this.inputs[2].getValue().trim(),
		};
	}

	handleInput(data: string): NewSessionKey {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) return "cancel";
		if (kb.matches(data, "tui.input.submit") || data === "\r" || data === "\n") return "submit";
		if (matchesKey(data, "tab") || kb.matches(data, "tui.select.down")) {
			this.focus = (this.focus + 1) % this.inputs.length;
			return "handled";
		}
		if (kb.matches(data, "tui.select.up")) {
			this.focus = (this.focus + this.inputs.length - 1) % this.inputs.length;
			return "handled";
		}
		this.inputs[this.focus].handleInput(data);
		return "handled";
	}

	render(width: number): string[] {
		const out: string[] = [theme.fg("dim", "New session")];
		for (let i = 0; i < this.inputs.length; i++) {
			const active = i === this.focus;
			const label = theme.fg(active ? "accent" : "dim", LABELS[i].padEnd(6));
			const value = active
				? this.inputs[i].render(Math.max(1, width - 8))[0]
				: theme.fg("muted", this.inputs[i].getValue());
			out.push(truncateToWidth(`${label} ${value}`, width));
		}
		return out;
	}
}
