/**
 * pi's `shellCommandPrefix` put before a command, joined as pi's own bash joins them (`core/tools/bash.js`).
 */
export function withCommandPrefix(prefix: string | undefined, command: string): string {
	return prefix ? `${prefix}\n${command}` : command;
}
