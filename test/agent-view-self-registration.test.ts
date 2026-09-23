import { describe, expect, it } from "vitest";
import type { OrchestratorClient, RegisterInput } from "../ext/agent-view/orchestrator-client.ts";
import { deriveLabel, ForegroundActivity, SelfRegistration } from "../ext/agent-view/self-registration.ts";

describe("ForegroundActivity (what the roster shows for THIS window)", () => {
	it("starts idle, works during an agent run, and settles back to idle", () => {
		const fg = new ForegroundActivity();
		expect(fg.current).toBe("idle");
		expect(fg.apply({ type: "agent_start" })).toBe("working");
		expect(fg.apply({ type: "turn_start" })).toBe("working");
		expect(fg.apply({ type: "agent_settled" })).toBe("idle");
	});

	it("a blocking prompt mid-run is 'needs input'; answering it resumes 'working'", () => {
		const fg = new ForegroundActivity();
		fg.apply({ type: "agent_start" });
		expect(fg.apply({ type: "ui_prompt_start", kind: "confirm" })).toBe("awaiting_input");
		expect(fg.apply({ type: "ui_prompt_end", kind: "confirm" })).toBe("working");
	});

	it("a blocking prompt outside a run goes back to idle when answered", () => {
		const fg = new ForegroundActivity();
		expect(fg.apply({ type: "ui_prompt_start", kind: "select" })).toBe("awaiting_input");
		expect(fg.apply({ type: "ui_prompt_end", kind: "select" })).toBe("idle");
	});

	it("a 'custom' overlay (agent view itself, /diff, …) is not a question for the user", () => {
		const fg = new ForegroundActivity();
		fg.apply({ type: "agent_start" });
		expect(fg.apply({ type: "ui_prompt_start", kind: "custom" })).toBe("working");
		expect(fg.apply({ type: "ui_prompt_end", kind: "custom" })).toBe("working");
	});

	it("ignores unrelated events", () => {
		const fg = new ForegroundActivity();
		expect(fg.apply({ type: "tool_execution_start" })).toBe("idle");
	});
});

describe("deriveLabel (roster title for the foreground session)", () => {
	const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
	const assistant = (text: string) => ({ type: "message", message: { role: "assistant", content: text } });

	it("prefers the session's name", () => {
		expect(deriveLabel("my refactor", [user("do the thing")])).toBe("my refactor");
	});

	it("falls back to the first user message, first line only, trimmed to 60 chars", () => {
		const long = `  ${"x".repeat(70)}\nsecond line`;
		expect(deriveLabel(undefined, [assistant("hi"), user(long)])).toBe("x".repeat(60));
	});

	it("reads text blocks out of a structured user message", () => {
		const entry = {
			type: "message",
			message: { role: "user", content: [{ type: "image" }, { type: "text", text: "fix the footer" }] },
		};
		expect(deriveLabel(undefined, [entry])).toBe("fix the footer");
	});

	it("is undefined for an empty session, so the roster shows the id", () => {
		expect(deriveLabel(undefined, [])).toBeUndefined();
		expect(deriveLabel("", [assistant("hi")])).toBeUndefined();
	});
});

describe("SelfRegistration heartbeats", () => {
	function fakeClient() {
		const calls: RegisterInput[] = [];
		const client = {
			register: async (input: RegisterInput) => {
				calls.push(input);
			},
			unregister: async () => {},
		} as unknown as OrchestratorClient;
		return { client, calls };
	}

	it("re-registers immediately with the new activity when it changes", async () => {
		const { client, calls } = fakeClient();
		const reg = new SelfRegistration(client, () => ({ cwd: "/p", label: "deploy" }));
		reg.setActivity("working");
		await new Promise((r) => setTimeout(r, 0));
		expect(calls.at(-1)?.activity).toBe("working");
		expect(calls.at(-1)?.label).toBe("deploy");
		reg.setActivity("working"); // unchanged: no extra heartbeat
		await new Promise((r) => setTimeout(r, 0));
		expect(calls.length).toBe(1);
	});
});
