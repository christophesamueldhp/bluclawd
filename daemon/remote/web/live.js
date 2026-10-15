// @ts-check
/** @typedef {import("./app.js").LiveSnapshot} LiveSnapshot @typedef {import("./app.js").Message} Message */

/**
 * What is left of the reply in progress once a transcript fetch lands. A tool goes once the
 * transcript has its result. The text and thinking go only once the reply `ended` (its pane sent
 * null) and the transcript's last assistant message starts with them: pi writes the message after
 * it tells the phone the reply ended, so a fetch can land before the message is there, and a
 * fetch mid-reply never has it.
 * @param {LiveSnapshot | undefined} live @param {boolean} ended @param {Message[]} messages
 * @returns {LiveSnapshot | undefined}
 */
export function settle(live, ended, messages) {
	if (!live) return undefined;
	const done = new Set(messages.map((m) => (m.kind === "toolResult" ? m.toolCallId : undefined)));
	const tools = live.tools.filter((t) => !done.has(t.id));
	const last = [...messages].reverse().find((m) => m.kind === "assistant");
	const written =
		ended &&
		last !== undefined &&
		(last.text ?? "").startsWith(live.text) &&
		(last.thinking ?? "").startsWith(live.thinking ?? "");
	const rest = written ? { text: "", tools } : { ...live, tools };
	return rest.text || rest.thinking || rest.tools.length ? rest : undefined;
}

/**
 * What the transcript shows for a prompt sent with `images` images: an image is an `[Image]` line.
 * @param {string} text @param {number} images
 */
export function promptKey(text, images) {
	return [text, ...Array(images).fill("[Image]")].join("\n");
}

/**
 * A message's text as its bubble shows it: without its `[Image]` lines when its images show
 * instead. Only for display; matching and editing go by the transcript's text.
 * @param {string} text @param {unknown[] | undefined} images
 */
export function shownText(text, images) {
	return images?.length
		? text
				.split("\n")
				.filter((line) => line !== "[Image]")
				.join("\n")
		: text;
}

/**
 * A user message's text as it was sent: pi puts a note on an image it resized or converted
 * (`[Image: original …]`) under the prompt's text, above the transcript's `[Image]` lines.
 * @param {string} text
 */
export function sentText(text) {
	return text.trim().replace(/\n\n\[Image[ :][^\n]*\](?:\n\[Image[ :][^\n]*\])*(?=(?:\n\[Image\])+$)/, "");
}

/**
 * What becomes of a sent prompt still waiting once its time is up. One whose session was seen
 * working since, or is working or waiting on a dialog now, waits on (its turn's end drops it). Else
 * it reached the session only if the transcript moved meanwhile, or it is a command, which may
 * write nothing: it goes quietly. One that did neither never got there: it "fails", and goes back
 * into the reply box.
 * @param {{ prompt: string, started?: boolean, last: string }} pending `last`: the transcript's last message when sent
 * @param {string | undefined} sessionState @param {string} last its last message now
 * @returns {"wait" | "drop" | "fail"}
 */
export function giveUp(pending, sessionState, last) {
	if (pending.started || sessionState === "working" || sessionState === "needs") return "wait";
	return pending.prompt.startsWith("/") || last !== pending.last ? "drop" : "fail";
}

/**
 * The commands the phone runs itself rather than sending: `/compact` is its Compact, and `/model`
 * its model picker. Anything else is sent as typed.
 * @param {string} text @returns {"compact" | "model" | undefined}
 */
export function shortcut(text) {
	const command = text.trim();
	return command === "/compact" ? "compact" : command === "/model" ? "model" : undefined;
}

/**
 * The commands the phone does not send: they drive the Mac's terminal (its remote control, agent
 * view), not the session. Every other "/" line goes, and runs as a command or template in the pane.
 * @param {string} text
 */
export function refused(text) {
	const command = text.trim();
	return command.startsWith("/remote-control") || command.startsWith("/agent-view");
}

/**
 * A message of yours as pi's editor holds it, for the reply box or the clipboard: the transcript
 * shows each image as an `[Image]` line, and only the text is kept.
 * @param {string} text
 */
export function promptText(text) {
	return text
		.split("\n")
		.filter((line) => line !== "[Image]")
		.join("\n");
}
