// @ts-check
import { ICONS } from "./icons.js";

/**
 * A choice among a few values, as a sheet from the bottom, where the thumb is: iOS draws a
 * `<select>`'s menu wherever it finds room, over whatever is under it.
 * @typedef {{ value: string, label: string }} Option
 * @typedef {{ label?: string, options: Option[] }} Group
 * @typedef {{ title: string, groups: Group[], value: string }} Choice
 */

/** @param {unknown} text */
function esc(text) {
	return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Models by provider, in the order given, which is by provider already.
 * @template {{ provider: string, id: string, name?: string }} M
 * @param {M[]} models @param {(model: M, index: number) => string} toValue @returns {Group[]}
 */
export function modelGroups(models, toValue) {
	/** @type {Group[]} */
	const groups = [];
	models.forEach((model, index) => {
		if (model.provider !== models[index - 1]?.provider) groups.push({ label: model.provider, options: [] });
		groups[groups.length - 1].options.push({ value: toValue(model, index), label: model.name ?? model.id });
	});
	return groups;
}

/** @param {Choice} choice */
export function pickerHtml(choice) {
	const groups = choice.groups
		.filter((group) => group.options.length)
		.map((group) => {
			const options = group.options
				.map((option) => {
					const on = option.value === choice.value;
					return `<button type="button" class="option" role="option" aria-selected="${on}" data-value="${esc(option.value)}"><span>${esc(option.label)}</span>${on ? ICONS.check : ""}</button>`;
				})
				.join("");
			return `${group.label ? `<h3 class="group">${esc(group.label)}</h3>` : ""}<div class="options" role="listbox">${options}</div>`;
		})
		.join("");
	return `<header class="sheet-bar"><h2>${esc(choice.title)}</h2><button class="icon-btn close" data-close aria-label="Close">${ICONS.close}</button></header>${groups}`;
}

/** @type {((value: string) => void) | undefined} */
let picked;

/** The picker's sheet and backdrop, outside #app, which a view change replaces whole. */
function layer() {
	let sheet = /** @type {HTMLElement | null} */ (document.getElementById("picker"));
	if (sheet) return sheet;
	const backdrop = document.createElement("div");
	backdrop.className = "backdrop picker-backdrop";
	backdrop.id = "picker-backdrop";
	backdrop.hidden = true;
	sheet = document.createElement("section");
	sheet.className = "sheet picker";
	sheet.id = "picker";
	sheet.setAttribute("role", "dialog");
	sheet.hidden = true;
	document.body.append(backdrop, sheet);
	backdrop.addEventListener("click", closePicker);
	sheet.addEventListener("click", (event) => {
		const target = /** @type {Element} */ (event.target);
		const option = /** @type {HTMLElement | null} */ (target.closest(".option"));
		if (option) {
			const then = picked;
			closePicker();
			then?.(option.dataset.value ?? "");
		} else if (target.closest("[data-close]")) closePicker();
	});
	return sheet;
}

/** Shows the choice; `onPick` gets the value tapped, the current one included. @param {Choice} choice @param {(value: string) => void} onPick */
export function openPicker(choice, onPick) {
	const sheet = layer();
	picked = onPick;
	sheet.setAttribute("aria-label", choice.title);
	sheet.innerHTML = pickerHtml(choice);
	sheet.hidden = false;
	/** @type {HTMLElement} */ (document.getElementById("picker-backdrop")).hidden = false;
	// The current value in view in a long list.
	sheet.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "center" });
}

export function closePicker() {
	picked = undefined;
	const sheet = document.getElementById("picker");
	if (!sheet || sheet.hidden) return;
	sheet.hidden = true;
	/** @type {HTMLElement} */ (document.getElementById("picker-backdrop")).hidden = true;
}
