import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { addProjectRule, onRulesChanged, removeProjectRule } from "../ext/_shared/settings-write.ts";

describe("onRulesChanged", () => {
	afterEach(() => onRulesChanged(undefined));

	it("fires after a rule is saved to disk and after one is removed", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "rules-changed-"));
		const seen: string[] = [];
		onRulesChanged(() => {
			// The listener reloads from disk, so the file must already hold the change.
			seen.push(readFileSync(join(cwd, CONFIG_DIR_NAME, "settings.json"), "utf-8"));
		});
		await addProjectRule(cwd, "allow", "WebFetch(domain:example.com)", true);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain("WebFetch(domain:example.com)");
		await removeProjectRule(cwd, "WebFetch(domain:example.com)", true);
		expect(seen).toHaveLength(2);
		expect(seen[1]).not.toContain("example.com");
		// Nothing to remove, nothing to reload.
		await removeProjectRule(cwd, "WebFetch(domain:example.com)", true);
		expect(seen).toHaveLength(2);
	});
});
