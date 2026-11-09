/**
 * The settings files, read once per `session_start` and shared by every extension's handler for it.
 *
 * pi hands one event object to every handler of a `session_start`, so the read is keyed on it:
 * the next `session_start` (a /reload, /new, /resume) reads again. Only for reads a
 * `session_start` handler makes; a read later in the session (a command, a shortcut) still
 * opens the files itself, to see an edit made since.
 */
import { type ExtensionContext, type SessionStartEvent, SettingsManager } from "@earendil-works/pi-coding-agent";
import { sharedRef } from "./global-state.ts";

type SettingsCtx = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;

export interface StartupSettings {
	/** Shared by every handler: read it, never set it. */
	settings: SettingsManager;
	/** What `settings.drainErrors()` returned, kept for every handler that reports it. */
	errors: ReturnType<SettingsManager["drainErrors"]>;
}

const reads = sharedRef("startupSettings", new WeakMap<SessionStartEvent, Map<string, StartupSettings>>());

/** The settings files as they are now, for one reader. */
export function readSettings(ctx: SettingsCtx): StartupSettings {
	const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
	return { settings, errors: settings.drainErrors() };
}

export function startupSettings(event: SessionStartEvent, ctx: SettingsCtx): StartupSettings {
	// Keyed by trust and cwd too: a read made before the project was trusted must not hand its
	// project settings, or their absence, to a handler that sees it trusted.
	const key = `${ctx.isProjectTrusted()}:${ctx.cwd}`;
	const byKey = reads.get().get(event) ?? new Map<string, StartupSettings>();
	reads.get().set(event, byKey);
	let read = byKey.get(key);
	if (!read) {
		read = readSettings(ctx);
		byKey.set(key, read);
	}
	return read;
}
