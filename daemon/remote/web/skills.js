// @ts-check
/** @typedef {import("./statusbar.js").Command} Command */
/** @typedef {{command: Command, marker: string, start: number}} Selection */
/** @typedef {{text: string, selections: Selection[]}} SkillDraft */
/** @param {unknown} text */
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** @param {Command} command */
export function skillProvenance(command) {
	const info = command.skill;
	if (!info) return "";
	return `${info.scope[0].toUpperCase()}${info.scope.slice(1)}${info.origin === "package" ? ` · ${info.source}` : ""} · ${info.path}`;
}

/** A Chat draft owns its selections; spelling a marker never creates an identity.
 * @param {SkillDraft} [initial]
 */
export function createSkillDraft(initial = { text: "", selections: [] }) {
	let text = initial.text;
	let selections = initial.selections
		.filter(
			(s) =>
				typeof s?.marker === "string" &&
				s.command?.skill &&
				Number.isInteger(s.start) &&
				s.start >= 0 &&
				text.slice(s.start, s.start + s.marker.length) === s.marker,
		)
		.map((s) => ({ ...s }));
	let next = 1;
	return {
		get text() {
			return text;
		},
		snapshot() {
			return { text, selections: selections.map((s) => ({ ...s })) };
		},
		/** Preserve identities outside the actual edited range, including edits of identical text.
		 * @param {string} value @param {number} [before] @param {number} [after]
		 */
		edit(value, before, after) {
			let start = 0;
			const limit = before === undefined || after === undefined ? Infinity : Math.min(before, after);
			while (start < limit && start < text.length && start < value.length && text[start] === value[start]) start++;
			let oldEnd = text.length,
				newEnd = value.length;
			while (
				oldEnd > start &&
				newEnd > start &&
				(before === undefined || oldEnd > before) &&
				(after === undefined || newEnd > after) &&
				text[oldEnd - 1] === value[newEnd - 1]
			) {
				oldEnd--;
				newEnd--;
			}
			selections = selections.filter((s) => {
				if (s.start + s.marker.length <= start) return true;
				if (s.start >= oldEnd) {
					s.start += newEnd - oldEnd;
					return true;
				}
				return false;
			});
			text = value;
		},
		/** @param {Command} command @param {number} start @param {number} end */
		choose(command, start, end) {
			if (!command.skill) return;
			let marker;
			do {
				marker = `[Skill #${next++}: ${command.name.replace(/^skill:/, "")}]`;
			} while (text.includes(marker));
			this.edit(text.slice(0, start) + marker + text.slice(end), end, start + marker.length);
			selections.push({ command, marker, start });
		},
		/** @param {number} index */
		remove(index) {
			const s = selections[index];
			if (s)
				this.edit(
					text.slice(0, s.start) + text.slice(s.start + s.marker.length),
					s.start + s.marker.length,
					s.start,
				);
		},
		/** Autocomplete at the caret, anywhere in multiline text. @param {Command[]} commands @param {number} cursor */
		suggestions(commands, cursor) {
			const prefix = text.slice(0, cursor).match(/(?:^|\s)(\/[^\s/]*)$/)?.[1];
			if (!prefix) return [];
			const start = cursor - prefix.length;
			const inline = text.slice(0, start).trim().length > 0;
			const query = prefix.replace(/^\/(?:skill:)?/, "").toLowerCase();
			return commands
				.filter((c) => {
					if (c.source === "skill") return !!c.skill && c.name.slice(6).toLowerCase().startsWith(query);
					return !inline && !prefix.startsWith("/skill:") && c.name.toLowerCase().startsWith(query);
				})
				.map((command) => ({ command, start, end: cursor }));
		},
		selectedHtml() {
			return selections
				.map(
					(s, i) =>
						`<div class="selected-skill"><b>${esc(s.marker)}</b><small>${esc(skillProvenance(s.command))}</small><button type="button" data-remove-skill="${i}" aria-label="Remove ${esc(s.command.name)}">×</button></div>`,
				)
				.join("");
		},
		submit() {
			let prompt = text;
			for (const s of [...selections].sort((a, b) => b.start - a.start))
				prompt = `${prompt.slice(0, s.start)}/${s.command.name}${prompt.slice(s.start + s.marker.length)}`;
			return {
				text: prompt.trim(),
				skills: [...new Set(selections.flatMap((s) => (s.command.skill ? [s.command.skill.id] : [])))],
			};
		},
	};
}
