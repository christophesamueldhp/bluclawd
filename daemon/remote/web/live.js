// @ts-check
/** @typedef {import("./app.js").LiveSnapshot} LiveSnapshot @typedef {import("./app.js").Message} Message */

/**
 * @param {LiveSnapshot | undefined} live @param {boolean} retracted @param {Message[]} messages
 * @returns {LiveSnapshot | undefined}
 */
export function settle(live, retracted, messages) {
	if (!live) return undefined;
	const done = new Set(messages.map((m) => (m.kind === "toolResult" ? m.toolCallId : undefined)));
	const tools = live.tools.filter((t) => !done.has(t.id));
	const last = [...messages].reverse().find((m) => m.kind === "assistant");
	const written =
		retracted &&
		last !== undefined &&
		(last.text ?? "").startsWith(live.text) &&
		(last.thinking ?? "").startsWith(live.thinking ?? "");
	const rest = written ? { text: "", tools } : { ...live, tools };
	return rest.text || rest.thinking || rest.tools.length ? rest : undefined;
}

/** @param {string} text @param {number} images */
export function promptKey(text, images) {
	return [text, ...Array(images).fill("[Image]")].join("\n");
}

/** @param {string} text @param {unknown[] | undefined} images */
export function shownText(text, images) {
	return images?.length
		? text
				.split("\n")
				// pi's note on an image it resized (`[Image: original …]`) too, since the picture shows itself.
				.filter((line) => !/^\[Image(?:[ :].*)?\]$/.test(line))
				.join("\n")
				.trimEnd()
		: text;
}

const PANE_IMAGE_LINE = String.raw`\[Image #\d+\]`;
const PI_IMAGE_NOTE = String.raw`\[Image(?! #\d+\])[ :][^\n]*\]`;
const ADDED_LINE = `(?:${PANE_IMAGE_LINE}|${PI_IMAGE_NOTE})`;
const ADDED_BEFORE_IMAGES = new RegExp(String.raw`\n\n${ADDED_LINE}(?:\n\n?${ADDED_LINE})*(?=(?:\n\[Image\])+$)`);

/** @param {string} text */
export function sentText(text) {
	return text.trim().replace(ADDED_BEFORE_IMAGES, "");
}

/** @param {{ prompt: string, sawWorking?: boolean, lastIdWhenSent: string }} pending @param {string | undefined} sessionState @param {string} last @returns {"wait" | "drop" | "fail"} */
export function giveUp(pending, sessionState, last) {
	if (pending.sawWorking || sessionState === "working" || sessionState === "needs") return "wait";
	return mayWriteNothing(pending.prompt) || last !== pending.lastIdWhenSent ? "drop" : "fail";
}

/** @param {string} prompt */
function mayWriteNothing(prompt) {
	return /^\s*\//.test(prompt) || shellLine(prompt);
}

/** A `!` or `!!` line is pi's own shell, which only its prompt runs. Sent to the model, it is text. @param {string} text */
export function shellLine(text) {
	return /^!+\s*\S/.test(text.trimStart());
}

/** @param {string} text @param {{ name: string }[] | undefined} commands */
export function refused(text, commands) {
	const name = /^\/([\w.:-]+)(?:\s|$)/.exec(text.trimStart())?.[1];
	return (
		name !== undefined &&
		!name.startsWith("skill:") &&
		commands !== undefined &&
		!commands.some((c) => c.name === name)
	);
}
