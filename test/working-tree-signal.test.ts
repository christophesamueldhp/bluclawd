import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyingWhenSettled, onWorkingTreeChanged, workingTreeChanged } from "../ext/_shared/working-tree.ts";

describe("working-tree change signal", () => {
	afterEach(() => onWorkingTreeChanged(undefined));

	it("reaches the registered listener, and is a no-op without one", () => {
		const listener = vi.fn();
		workingTreeChanged();
		onWorkingTreeChanged(listener);
		workingTreeChanged();
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("fires once the wrapped command settles, not when it starts", async () => {
		const listener = vi.fn();
		onWorkingTreeChanged(listener);
		let finish: (value: { exitCode: number }) => void = () => {};
		const operations = notifyingWhenSettled({
			exec: () =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		});

		const running = operations.exec("git commit", "/repo", { onData: () => {} });
		expect(listener).not.toHaveBeenCalled();
		finish({ exitCode: 0 });
		await expect(running).resolves.toEqual({ exitCode: 0 });
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("fires after a failing command too, and still surfaces the failure", async () => {
		const listener = vi.fn();
		onWorkingTreeChanged(listener);
		const operations = notifyingWhenSettled({
			exec: async () => {
				throw new Error("spawn failed");
			},
		});
		await expect(operations.exec("x", "/repo", { onData: () => {} })).rejects.toThrow("spawn failed");
		expect(listener).toHaveBeenCalledTimes(1);
	});
});
