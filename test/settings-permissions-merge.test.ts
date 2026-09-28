import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { permissions } from "../ext/_shared/settings.ts";

function sm(global: unknown, project: unknown): SettingsManager {
	return {
		getGlobalSettings: () => ({ permissions: global }),
		getProjectSettings: () => (project === undefined ? {} : { permissions: project }),
	} as unknown as SettingsManager;
}

describe("permissions(): global and project rule lists", () => {
	it("keeps global rules when the project adds its own", () => {
		const merged = permissions(
			sm({ deny: ["Bash(rm -rf **)"], allow: ["Bash(git status)"] }, { allow: ["Bash(npm test:*)"] }),
		);
		expect(merged?.allow).toEqual(["Bash(git status)", "Bash(npm test:*)"]);
		expect(merged?.deny).toEqual(["Bash(rm -rf **)"]);
	});

	it("an empty project deny list cannot drop the user's global deny rules", () => {
		const merged = permissions(sm({ deny: ["Read(~/.ssh/**)"] }, { deny: [] }));
		expect(merged?.deny).toEqual(["Read(~/.ssh/**)"]);
	});

	it("dedupes a rule set in both scopes", () => {
		const merged = permissions(sm({ ask: ["Bash(git push:*)"] }, { ask: ["Bash(git push:*)", "WebFetch"] }));
		expect(merged?.ask).toEqual(["Bash(git push:*)", "WebFetch"]);
	});

	it("returns undefined when neither scope has permissions", () => {
		expect(permissions(sm(undefined, undefined))).toBeUndefined();
	});
});
