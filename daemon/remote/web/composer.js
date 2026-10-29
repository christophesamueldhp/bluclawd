// @ts-check

/**
 * Shows or hides the new task's options; hiding them drops the keyboard from the directory.
 * @param {boolean} expanded @param {(selector: string) => any} $
 */
export function setNewOptions(expanded, $) {
	$("#new-task").classList.toggle("expanded", expanded);
	const button = $("#new-options");
	button.setAttribute("aria-expanded", String(expanded));
	button.setAttribute("aria-label", expanded ? "Hide task options" : "Show task options");
	if (!expanded) $("#cwd").blur();
}
