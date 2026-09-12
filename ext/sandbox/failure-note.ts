/**
 * Sandbox failure note (audit C.1 follow-up).
 *
 * When a sandboxed command fails, the model needs to know the sandbox was in
 * play — otherwise it reads "Operation not permitted" as a broken script and
 * retries the same thing. This appends a short, DETERMINISTIC note derived
 * from the active configuration.
 *
 * Why not report the actual OS denial? sandbox-runtime can stream macOS
 * sandbox violations (`initialize(..., enableLogMonitor=true)`), but measured
 * against the real runtime that path does not deliver: the `log stream`
 * subprocess needs seconds to attach (so the first commands report nothing),
 * attribution depends on the violation line and its `CMD64_` marker landing in
 * the same stdout chunk, Linux/bubblewrap has no feeder at all, and on macOS
 * the denial that actually failed the command (file-write) did not surface —
 * only unrelated noise like `deny(1) sysctl-read kern.iossupportversion` did.
 * Injecting that into the transcript would mislead the model on every failure,
 * so this note states what is known for certain instead of guessing.
 */

import type { SandboxConfig } from "./config.ts";

const MAX_LISTED = 6;

/**
 * What a denied file or network operation prints. A non-zero exit alone is not
 * evidence: grep with no match, `test -f`, and `diff` all exit 1 in the normal
 * course of things, and noting the sandbox on every one of those would teach
 * the model to read the note as noise.
 */
const DENIAL_SIGNATURES =
	/operation not permitted|permission denied|\bE(?:PERM|ACCES|CONNREFUSED|NETUNREACH|HOSTUNREACH)\b|could not resolve host|connection refused|network is unreachable|no route to host|sandbox-exec|\bbwrap\b/i;

export function looksLikeSandboxDenial(output: string): boolean {
	return DENIAL_SIGNATURES.test(output);
}

/**
 * The violation lines worth showing the model: the file or host the sandbox
 * denied. The runtime records every Seatbelt denial, and each command also trips
 * a few that have nothing to do with the failure (`sysctl-read
 * kern.iossupportversion`, `mach-lookup ...configd`); those would be read as the
 * cause, so only file and network denials are kept.
 */
const RELEVANT_VIOLATION = /\bfile-(?:read|write)|\bnetwork-outbound\b|\bnetwork\b/;

export function relevantViolations(lines: string[]): string[] {
	return [...new Set(lines.filter((line) => RELEVANT_VIOLATION.test(line)))];
}

/** Claude Code's shape: the denials, verbatim, in a `<sandbox_violations>` block. */
export function formatSandboxViolations(lines: string[]): string {
	return ["", "<sandbox_violations>", ...lines, "</sandbox_violations>"].join("\n");
}

function summarize(values: string[] | undefined): string {
	if (!values || values.length === 0) return "none";
	if (values.length <= MAX_LISTED) return values.join(", ");
	return `${values.slice(0, MAX_LISTED).join(", ")} (+${values.length - MAX_LISTED} more)`;
}

/**
 * denyRead is the operator's inventory of what is secret (~/.ssh, ~/.aws, key
 * files). Naming those paths to the model hands a prompt-injected agent a map
 * of the highest-value targets, so only the count is reported.
 */
function countOnly(values: string[] | undefined): string {
	const n = values?.length ?? 0;
	return n === 0 ? "none" : `${n} path${n === 1 ? "" : "s"}`;
}

/**
 * The note appended to a failed sandboxed command's output. Returns undefined
 * when there is nothing useful to say (no restrictions configured at all).
 */
export function buildSandboxFailureNote(config: SandboxConfig): string | undefined {
	const allowWrite = config.filesystem?.allowWrite;
	const denyWrite = config.filesystem?.denyWrite;
	const denyRead = config.filesystem?.denyRead;
	const allowedDomains = config.network?.allowedDomains;
	if (!allowWrite?.length && !denyWrite?.length && !denyRead?.length && !allowedDomains?.length) {
		return undefined;
	}

	return [
		"",
		"<sandbox_note>",
		"This command ran inside the OS sandbox, which may have denied it.",
		`  writes allowed: ${summarize(allowWrite)}`,
		`  writes denied: ${summarize(denyWrite)}`,
		`  reads denied: ${countOnly(denyRead)}`,
		`  network pre-allowed: ${summarize(allowedDomains)} (other hosts ask the user first, or are denied when nobody can answer)`,
		"If the failure looks like a permission or network error, it is likely the sandbox.",
		"Work within these limits; do not attempt to disable or circumvent them.",
		"</sandbox_note>",
		"",
	].join("\n");
}
