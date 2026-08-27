/**
 * Normalising a raw `keybindings.json` object into pi's `KeybindingsConfig`.
 *
 * pi has exactly this function and does not export it. `/doctor`'s keybindings
 * check needs the same drop logic the real loader uses — a key whose value is
 * neither a string nor an array of strings is silently ignored — so that the
 * check cannot report a binding as accepted when the loader will throw it away.
 *
 * This is the one place in the layer that duplicates pi logic rather than
 * calling it, so it is the one place that can drift: if pi's loader starts
 * accepting another value shape, `/doctor` will under-report until this follows.
 * Twelve lines was judged the cheaper risk against editing pi to add an
 * `export`.
 */
import type { KeybindingsConfig, KeyId } from "@earendil-works/pi-tui";

export function toKeybindingsConfig(value: Record<string, unknown>): KeybindingsConfig {
	const config: KeybindingsConfig = {};
	for (const [key, binding] of Object.entries(value)) {
		if (typeof binding === "string") {
			config[key] = binding as KeyId;
			continue;
		}
		if (Array.isArray(binding) && binding.every((entry) => typeof entry === "string")) {
			config[key] = binding as KeyId[];
		}
	}
	return config;
}
