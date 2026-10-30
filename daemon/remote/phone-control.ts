/**
 * Phone control: for one session, whether a Chat's action is allowed and what it becomes.
 */

/** A `!` or `!!` line is pi's own shell, which only its prompt runs: sent to the model, it is text.
 *  The phone app keeps a copy (web/live.js), held to this one by a shared test table. */
export function shellLine(text: string): boolean {
	return /^!+\s*\S/.test(text.trimStart());
}
