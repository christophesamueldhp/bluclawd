/**
 * What bash mode's commands printed, for the widget below the editor. Capped so
 * a noisy command cannot grow it without bound: past either limit the oldest
 * commands go, but the newest always stays, however large.
 *
 * Adapted from pi-powerline-footer's bash-mode transcript (MIT, Nico Bailon).
 */

export interface ShellCommandRecord {
	id: string;
	command: string;
	cwdAtStart: string;
	output: string[];
	outputBytes: number;
	/** null while the command runs. */
	exitCode: number | null;
}

export interface TranscriptLimits {
	maxLines: number;
	maxBytes: number;
}

const DEFAULT_LIMITS: TranscriptLimits = { maxLines: 2000, maxBytes: 512 * 1024 };

export class ShellTranscript {
	private readonly limits: TranscriptLimits;
	private readonly records: ShellCommandRecord[] = [];
	private totalLines = 0;
	private totalBytes = 0;
	private droppedCommands = 0;

	constructor(limits: TranscriptLimits = DEFAULT_LIMITS) {
		this.limits = limits;
	}

	get commands(): readonly ShellCommandRecord[] {
		return this.records;
	}

	/** Commands removed to stay within the limits. */
	get dropped(): number {
		return this.droppedCommands;
	}

	start(id: string, command: string, cwdAtStart: string): void {
		this.records.push({ id, command, cwdAtStart, output: [], outputBytes: 0, exitCode: null });
		this.enforceLimits();
	}

	append(id: string, line: string): void {
		const record = this.find(id);
		if (!record) return;
		const bytes = Buffer.byteLength(line, "utf8") + 1;
		record.output.push(line);
		record.outputBytes += bytes;
		this.totalLines += 1;
		this.totalBytes += bytes;
		this.enforceLimits();
	}

	finish(id: string, exitCode: number): void {
		const record = this.find(id);
		if (record) record.exitCode = exitCode;
	}

	private find(id: string): ShellCommandRecord | undefined {
		for (let i = this.records.length - 1; i >= 0; i--) {
			if (this.records[i].id === id) return this.records[i];
		}
		return undefined;
	}

	private enforceLimits(): void {
		while (
			this.records.length > 1 &&
			(this.totalLines > this.limits.maxLines || this.totalBytes > this.limits.maxBytes)
		) {
			const removed = this.records.shift();
			if (!removed) break;
			this.totalLines -= removed.output.length;
			this.totalBytes -= removed.outputBytes;
			this.droppedCommands += 1;
		}
	}
}
