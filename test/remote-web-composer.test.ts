import { describe, expect, it, vi } from "vitest";
import { setNewOptions } from "../daemon/remote/web/composer.js";

describe("new task options", () => {
	it("toggles the controls and accessible label without clearing the task or directory", () => {
		const classes = new Set<string>();
		const attributes = new Map<string, string>();
		const cwd = { value: "~/Projects/bluclawd", blur: vi.fn() };
		const task = { value: "Continue working" };
		const elements: Record<string, unknown> = {
			"#new-task": {
				classList: {
					toggle: (name: string, enabled: boolean) => (enabled ? classes.add(name) : classes.delete(name)),
				},
			},
			"#new-options": { setAttribute: (name: string, value: string) => attributes.set(name, value) },
			"#cwd": cwd,
			"#task": task,
		};
		const $ = (selector: string) => elements[selector];

		setNewOptions(true, $);
		expect(classes.has("expanded")).toBe(true);
		expect(attributes.get("aria-expanded")).toBe("true");
		expect(attributes.get("aria-label")).toBe("Hide task options");

		setNewOptions(false, $);
		expect(classes.has("expanded")).toBe(false);
		expect(attributes.get("aria-expanded")).toBe("false");
		expect(attributes.get("aria-label")).toBe("Show task options");
		expect(cwd.blur).toHaveBeenCalledOnce();
		expect(cwd.value).toBe("~/Projects/bluclawd");
		expect(task.value).toBe("Continue working");
	});
});
