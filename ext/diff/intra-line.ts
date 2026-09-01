/**
 * Word-level highlighting inside a changed diff line.
 *
 * pi has exactly this function in `components/diff.ts` and does not export it;
 * the fork branch added an `export`. Copied here instead, byte-for-byte, so the
 * side-by-side diff renders the same emphasis pi's inline diff does.
 *
 * Second and last place this layer duplicates pi logic (see
 * `_shared/keybindings-config.ts`). If pi changes how it emphasises word
 * changes, the side-by-side view will look subtly different until this follows.
 */
import * as Diff from "diff";
import { theme } from "../_shared/theme.ts";

export function renderIntraLineDiff(
	oldContent: string,
	newContent: string,
): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWords(oldContent, newContent);

	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;

	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			// Strip leading whitespace from the first removed part
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				removedLine += leadingWs;
				isFirstRemoved = false;
			}
			if (value) {
				removedLine += theme.inverse(value);
			}
		} else if (part.added) {
			let value = part.value;
			// Strip leading whitespace from the first added part
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				addedLine += leadingWs;
				isFirstAdded = false;
			}
			if (value) {
				addedLine += theme.inverse(value);
			}
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}

	return { removedLine, addedLine };
}
