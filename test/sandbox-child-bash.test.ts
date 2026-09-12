import { afterEach, describe, expect, it } from "vitest";
import { createChildBashExtension } from "../ext/sandbox/child-bash.ts";
import { publishChildBash } from "../ext/sandbox/state.ts";

function load() {
	const tools: any[] = [];
	const ext = createChildBashExtension(process.cwd());
	const factory = typeof ext === "function" ? ext : ext.factory;
	factory({ registerTool: (t: any) => tools.push(t) } as any);
	return tools;
}

describe("sandboxed bash for subagent children", () => {
	afterEach(() => publishChildBash(undefined));

	it("registers nothing while the parent sandbox is not active", () => {
		expect(load()).toEqual([]);
	});

	it("runs the child's commands through the parent's sandboxed operations", async () => {
		const seen: string[] = [];
		publishChildBash({
			operations: () => ({
				exec: async (command, _cwd, options) => {
					seen.push(command);
					options.onData(Buffer.from("sandboxed hi\n"));
					return { exitCode: 0 };
				},
			}),
			refusal: () => undefined,
		});
		const [bash] = load();
		expect(bash.name).toBe("bash");
		const result = await bash.execute("1", { command: "echo hi" }, undefined, undefined);
		expect(seen).toEqual(["echo hi"]);
		expect(result.content[0].text).toContain("sandboxed hi");
	});

	it("refuses to run at all when the parent's strict sandbox refuses", async () => {
		publishChildBash({ operations: () => ({ exec: async () => ({ exitCode: 0 }) }), refusal: () => "BLOCKED" });
		const [bash] = load();
		const result = await bash.execute("1", { command: "echo hi" }, undefined, undefined);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("BLOCKED");
	});
});
