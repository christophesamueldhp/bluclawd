/**
 * Vendored from pi's modes/interactive/components/keybinding-hints.ts —
 * not part of pi's public package export, but purely a string formatter:
 * `getKeybindings()` (the only thing that carries live state) is public and
 * queried at call time, so there is no static table here to drift.
 */
import { getKeybindings, type Keybinding, type KeyId } from "@earendil-works/pi-tui";

function formatKeyPart(part: string): string {
	const displayPart = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
	return displayPart.charAt(0).toUpperCase() + displayPart.slice(1);
}

function formatKeyText(key: string): string {
	return key
		.split("/")
		.map((k) => k.split("+").map(formatKeyPart).join("+"))
		.join("/");
}

function formatKeys(keys: KeyId[]): string {
	if (keys.length === 0) return "";
	return formatKeyText(keys.join("/"));
}

export function keyDisplayText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding));
}
