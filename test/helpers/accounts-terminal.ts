import type { Terminal } from "@earendil-works/pi-tui";

/** In-memory terminal: assertions read the current screen, not stale output history. */
export class AccountsTerminal implements Terminal {
	readonly columns = 140;
	readonly rows = 60;
	readonly kittyProtocolActive = false;
	private onInput?: (data: string) => void;
	private lines: string[][] = [[]];
	private row = 0;
	private column = 0;

	start(onInput: (data: string) => void): void {
		this.onInput = onInput;
	}
	stop(): void {
		this.onInput = undefined;
	}
	async drainInput(): Promise<void> {}
	send(data: string): void {
		if (!this.onInput) throw new Error("Terminal is not started");
		this.onInput(data);
	}
	get screen(): string {
		return this.lines.map((line) => line.join("").trimEnd()).join("\n");
	}
	write(data: string): void {
		const tokens =
			data.match(/\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b_[\s\S]*?\x07|[^\x1b]/gu) ?? [];
		for (const token of tokens) {
			if (token.startsWith("\x1b[")) {
				const command = token.at(-1);
				const values = token.slice(2, -1).split(";").map(Number);
				const amount = values[0] || 1;
				if (command === "A") this.row = Math.max(0, this.row - amount);
				if (command === "B") this.row += amount;
				if (command === "C") this.column += amount;
				if (command === "D") this.column = Math.max(0, this.column - amount);
				if (command === "G") this.column = amount - 1;
				if (command === "H") {
					this.row = amount - 1;
					this.column = (values[1] || 1) - 1;
				}
				if (command === "J") {
					if (values[0] === 2 || values[0] === 3) this.lines = [];
					else {
						this.lines.length = this.row + 1;
						this.clearFromCursor();
					}
				}
				if (command === "K") {
					if (values[0] === 2) this.clearLine();
					else this.clearFromCursor();
				}
			} else if (token === "\r") this.column = 0;
			else if (token === "\n") this.row++;
			else if (!token.startsWith("\x1b") && token >= " ") {
				const line = this.lines[this.row] ?? [];
				this.lines[this.row] = line;
				while (line.length < this.column) line.push(" ");
				line[this.column++] = token;
			}
		}
	}
	moveBy(lines: number): void {
		this.row = Math.max(0, this.row + lines);
	}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {
		this.lines[this.row] = [];
	}
	clearFromCursor(): void {
		const line = this.lines[this.row];
		if (line) line.length = Math.min(line.length, this.column);
	}
	clearScreen(): void {
		this.lines = [];
		this.row = 0;
		this.column = 0;
	}
	setTitle(): void {}
	setProgress(): void {}
}
