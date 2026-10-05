import type { RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { routeSessionCommand, stopSelectedSession } from "../ext/agent-view/session-commands.ts";
import type { SessionController } from "../ext/agent-view/session-controller.ts";

const context = { busy: false, commands: [] };
const route = (text: string, busy = false) => routeSessionCommand(text, { ...context, busy });
describe("managed session command destinations", () => {
	it("routes the installed maximum thinking level", () => {
		expect(route("/thinking max")).toEqual({ type: "rpc", command: { type: "set_thinking_level", level: "max" } });
	});
	it.each(["hello", "", "@ README.md explain"])("ordinary/image-only input is a prompt: %s", (text) =>
		expect(route(text)).toEqual({ type: "prompt", message: text }),
	);
	it.each([
		["/agent-view", "agents"],
		["/agents", "agents"],
		["/new", "new"],
		["/resume", "resume"],
		["/model", "model"],
		["/theme", "theme"],
		["/help", "help"],
		["/settings", "settings"],
		["/quit", "quit"],
		["/reload", "reload"],
	])("local navigation %s", (text, action) => expect(route(text)).toEqual({ type: "local", action }));
	it.each([
		["/status", "get_state"],
		["/state", "get_state"],
		["/context", "get_session_stats"],
		["/session", "get_session_stats"],
		["/stats", "get_session_stats"],
	])("remote inspection %s", (text, type) => expect(route(text, true)).toEqual({ type: "rpc", command: { type } }));
	it("routes model/thinking/name/compact to the execution owner", () => {
		expect(route("/model test/model/path")).toEqual({
			type: "rpc",
			command: { type: "set_model", provider: "test", modelId: "model/path" },
		});
		expect(route("/model cycle")).toEqual({ type: "rpc", command: { type: "cycle_model" } });
		expect(route("/thinking high")).toEqual({ type: "rpc", command: { type: "set_thinking_level", level: "high" } });
		expect(route("/thinking")).toEqual({ type: "rpc", command: { type: "cycle_thinking_level" } });
		expect(route("/thinking not-a-level").type).toBe("unavailable");
		expect(route("/name useful task with spaces")).toEqual({
			type: "rpc",
			command: { type: "set_session_name", name: "useful task with spaces" },
		});
		expect(route("/compact retain the checklist")).toEqual({
			type: "rpc",
			command: { type: "compact", customInstructions: "retain the checklist" },
		});
	});
	it.each(["/export", "/export-html", "/export_html", "/export html"])("HTML export alias %s", (text) =>
		expect(route(text)).toEqual({ type: "rpc", command: { type: "export_html" } }),
	);
	it("export paths remain complete and JSONL is never mislabeled HTML", () => {
		expect(route("/export report with spaces.html")).toEqual({
			type: "rpc",
			command: { type: "export_html", outputPath: "report with spaces.html" },
		});
		expect(route("/export html report.html")).toEqual({
			type: "rpc",
			command: { type: "export_html", outputPath: "report.html" },
		});
		expect(route("/export report.jsonl").type).toBe("unavailable");
	});
	it("explicit steering and bash target the selected child", () => {
		expect(route("/steer focus here", true)).toEqual({
			type: "rpc",
			command: { type: "steer", message: "focus here" },
		});
		expect(route("!pwd")).toEqual({
			type: "rpc",
			command: { type: "bash", command: "pwd", excludeFromContext: false },
		});
		expect(route("!! pwd")).toEqual({
			type: "rpc",
			command: { type: "bash", command: "pwd", excludeFromContext: true },
		});
	});
	it.each(["/tasks", "/bashes", "/rewind"])("%s clearly names the unsupported screen", (text) => {
		const result = route(text);
		expect(result.type).toBe("unavailable");
		if (result.type === "unavailable")
			expect(result.message).toMatch(/interactive.*unavailable|unavailable.*interactive/i);
	});
	it.each(["/fork", "/clone", "/tree", "/compact"])(
		"busy sensitive operation cannot reach the idle host: %s",
		(text) => expect(route(text, true).type).toBe("unavailable"),
	);
	it.each([
		"/share",
		"/copy",
		"/login",
		"/logout",
		"/trust",
		"/import",
		"/unknown",
		"/agent-view-release",
		"/constructor",
		"/toString",
		"/__proto__",
	])("unsupported commands never become model prompts: %s", (text) => expect(route(text).type).toBe("unavailable"));
	it("skills and templates are expanded only in the selected child", () => {
		for (const source of ["skill", "prompt"] as const)
			expect(
				routeSessionCommand("/review inspect files", { busy: false, commands: [{ name: "review", source }] }),
			).toEqual({ type: "prompt", message: "/review inspect files" });
		expect(
			routeSessionCommand("/skill:review", { busy: false, commands: [{ name: "review", source: "skill" }] }),
		).toEqual({ type: "prompt", message: "/skill:review" });
	});
	it("discovery is not proof of custom RPC UI compatibility", () => {
		const commands = [{ name: "custom", source: "extension" as const }];
		expect(routeSessionCommand("/custom", { busy: false, commands }).type).toBe("unavailable");
		expect(routeSessionCommand("/custom", { busy: false, commands, rpcCompatibleExtensions: ["custom"] })).toEqual({
			type: "prompt",
			message: "/custom",
		});
	});
});
describe("explicit selected-session stop", () => {
	function fixture() {
		let draft = { text: "current draft", images: [{ type: "image" as const, data: "AA==", mimeType: "image/png" }] };
		let id = "a";
		const send = vi.fn(
			async (command: RpcCommand): Promise<RpcResponse> =>
				command.type === "clear_queue"
					? {
							type: "response",
							command: "clear_queue",
							success: true,
							data: { steering: ["steer"], followUp: ["follow"] },
						}
					: { type: "response", command: "abort", success: true },
		);
		const controller = {
			selected: () => ({ instance: { id }, generation: "g" }),
			draft: () => draft,
			setDraft: (value: typeof draft) => {
				draft = value;
			},
			send,
		};
		return {
			controller: controller as unknown as SessionController,
			send,
			draft: () => draft,
			change: () => {
				id = "b";
			},
		};
	}
	it("clears queue before abort and restores text without dropping images", async () => {
		const f = fixture();
		await stopSelectedSession(f.controller);
		expect(f.send.mock.calls.map((call) => call[0].type)).toEqual(["clear_queue", "abort"]);
		expect(f.draft().text).toBe("steer\n\nfollow\n\ncurrent draft");
		expect(f.draft().images).toHaveLength(1);
	});
	it("queue failure surfaces and never sends abort", async () => {
		const f = fixture();
		f.send.mockResolvedValueOnce({
			type: "response",
			command: "clear_queue",
			success: false,
			error: "queue failure",
		});
		await expect(stopSelectedSession(f.controller)).rejects.toThrow("queue failure");
		expect(f.send).toHaveBeenCalledOnce();
	});
	it("abort failure surfaces to caller", async () => {
		const f = fixture();
		f.send.mockResolvedValueOnce({
			type: "response",
			command: "clear_queue",
			success: true,
			data: { steering: [], followUp: [] },
		});
		f.send.mockResolvedValueOnce({ type: "response", command: "abort", success: false, error: "abort failure" });
		await expect(stopSelectedSession(f.controller)).rejects.toThrow("abort failure");
	});
	it("selection changes cannot restore A queue into or abort B", async () => {
		const f = fixture();
		f.send.mockImplementationOnce(async () => {
			f.change();
			return {
				type: "response",
				command: "clear_queue",
				success: true,
				data: { steering: ["a only"], followUp: [] },
			};
		});
		await expect(stopSelectedSession(f.controller)).rejects.toThrow("changed");
		expect(f.draft().text).toBe("current draft");
		expect(f.send).toHaveBeenCalledOnce();
	});
});
