/**
 * pi's `shellCommandPrefix` put before a command, joined as pi's own bash joins them (`core/tools/bash.js`): every
 * shell command bluclawd runs for a model goes through here, so none can differ from pi's.
 */
export function withCommandPrefix(prefix: string | undefined, command: string): string {
	return prefix ? `${prefix}\n${command}` : command;
}
