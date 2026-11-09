/**
 * The settings files, read once per `session_start` and shared by every extension's handler for it.
 *
 * pi hands one event object to every handler of a `session_start`, so the read is keyed on it:
 * the next `session_start` (a /reload, /new, /resume) reads again. Only for reads a
 * `session_start` handler makes; a read later in the session (a command, a shortcut) still
 * opens the files itself, to see an edit made since.
 */
import { type ExtensionContext, SettingsManager } from "@earendil-works/pi-coding-agent";
import { sharedRef } from "./global-state.ts";

export interface StartupSettings {
	/** Shared by every handler: read it, never set it. */
	settings: SettingsManager;
	/** What `settings.drainErrors()` returned, kept for every handler that reports it. */
	errors: ReturnType<SettingsManager["drainErrors"]>;
}

const reads = sharedRef("startupSettings", new WeakMap<object, Map<string, StartupSettings>>());

export function startupSettings(
	event: object,
	ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
): StartupSettings {
	const projectTrusted = ctx.isProjectTrusted();
	const key = `${projectTrusted}:${ctx.cwd}`;
	const byKey = reads.get().get(event) ?? new Map<string, StartupSettings>();
	reads.get().set(event, byKey);
	let read = byKey.get(key);
	if (!read) {
		const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted });
		read = { settings, errors: settings.drainErrors() };
		byKey.set(key, read);
	}
	return read;
}
