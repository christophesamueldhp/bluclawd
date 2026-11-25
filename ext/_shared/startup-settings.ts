import { type ExtensionContext, type SessionStartEvent, SettingsManager } from "@earendil-works/pi-coding-agent";
import { sharedRef } from "./global-state.ts";

type SettingsCtx = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;

export interface StartupSettings {
	settings: SettingsManager;
	errors: ReturnType<SettingsManager["drainErrors"]>;
}

const reads = sharedRef("startupSettings", new WeakMap<SessionStartEvent, Map<string, StartupSettings>>());

export function readSettings(ctx: SettingsCtx): StartupSettings {
	const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
	return { settings, errors: settings.drainErrors() };
}

function trustAndCwdKey(ctx: SettingsCtx): string {
	return `${ctx.isProjectTrusted()}:${ctx.cwd}`;
}

export function startupSettings(event: SessionStartEvent, ctx: SettingsCtx): StartupSettings {
	const key = trustAndCwdKey(ctx);
	const byKey = reads.get().get(event) ?? new Map<string, StartupSettings>();
	reads.get().set(event, byKey);
	let read = byKey.get(key);
	if (!read) {
		read = readSettings(ctx);
		byKey.set(key, read);
	}
	return read;
}
