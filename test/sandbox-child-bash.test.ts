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

describe("a subagent child's bash is Claude Code's, like the parent's", () => {
	afterEach(() => publishChildBash(undefined));

	function loadWith(options?: { endsWithFinalResponse?: boolean }) {
		const tools: any[] = [];
		const ext = createChildBashExtension(process.cwd(), options);
		const factory = typeof ext === "function" ? ext : ext.factory;
		factory({ registerTool: (t: any) => tools.push(t), sendMessage: () => {} } as any);
		return tools[0];
	}

	it("takes run_in_background and a millisecond timeout, but cannot leave the sandbox", () => {
		publishChildBash({ operations: () => ({ exec: async () => ({ exitCode: 0 }) }), refusal: () => undefined });
		const props = loadWith().parameters.properties;
		expect(props.run_in_background).toBeDefined();
		expect(props.timeout.description).toBe("Optional timeout in milliseconds (max 600000)");
		expect(props.dangerouslyDisableSandbox).toBeUndefined();
	});

	it("starts jobs under the child's agent id, and warns a synchronous child they end with it", async () => {
		const { backgroundBashJobs } = await import("../ext/_shared/background-bash.ts");
		publishChildBash({
			operations: () => ({
				exec: (_c, _w, { signal }) =>
					new Promise((_r, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")))),
			}),
			refusal: () => undefined,
		});
		const bash = loadWith({ endsWithFinalResponse: true });
		const ctx = { sessionManager: { getSessionId: () => "child-7" } };
		const result = await bash.execute("1", { command: "server", run_in_background: true }, undefined, undefined, ctx);
		expect(result.content[0].text).toContain("it is terminated when you give your final response");
		const job = backgroundBashJobs.get(result.details.backgroundTaskId);
		expect(job).toMatchObject({ owner: "child-7", agentId: "child-7" });
		backgroundBashJobs.kill(job!.id);
	});
});
