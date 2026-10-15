import { describe, expect, it } from "vitest";
import {
	giveUp,
	promptKey,
	promptText,
	refused,
	sentText,
	settle,
	shortcut,
	shownText,
} from "../daemon/remote/web/live.js";

const assistant = (id: string, text: string, thinking?: string) => ({
	kind: "assistant",
	id,
	text,
	...(thinking ? { thinking } : {}),
	tools: [],
});
const result = (toolCallId: string) => ({ kind: "toolResult", id: `r-${toolCallId}`, toolCallId, ok: true, text: "" });
const tool = (id: string, running: boolean) => ({ id, name: "bash", summary: "ls", running });

describe("settle (the phone's reply in progress once a transcript fetch lands)", () => {
	it("keeps the text streaming mid-reply, even when an earlier message starts the same way", () => {
		const live = { text: "Hel", tools: [] };
		expect(settle(live, false, [assistant("a1", "Hello there")])).toEqual(live);
	});

	it("drops a finished reply once the transcript has it", () => {
		const live = { text: "Hello", thinking: "hmm", tools: [tool("c1", false)] };
		const messages = [assistant("a1", "Hello world", "hmm, ok"), result("c1")];
		expect(settle(live, true, messages)).toBeUndefined();
	});

	it("keeps a finished reply the transcript does not have yet", () => {
		const live = { text: "Second", tools: [] };
		expect(settle(live, true, [assistant("a1", "First")])).toEqual(live);
	});

	it("drops a tool once the transcript has its result, and keeps one still running", () => {
		const live = { text: "", tools: [tool("c1", true), tool("c2", true)] };
		expect(settle(live, false, [result("c1")])).toEqual({ text: "", tools: [tool("c2", true)] });
		expect(settle({ text: "", tools: [tool("c1", true)] }, false, [result("c1")])).toBeUndefined();
	});

	it("keeps the tools without a result when a finished reply's text goes", () => {
		const live = { text: "Hi", tools: [tool("c1", true)] };
		expect(settle(live, true, [assistant("a1", "Hi")])).toEqual({ text: "", tools: [tool("c1", true)] });
	});

	it("is nothing without a reply in progress", () => {
		expect(settle(undefined, true, [assistant("a1", "Hi")])).toBeUndefined();
	});
});

describe("a sent prompt as the transcript shows it", () => {
	it("is its text, then a line per image", () => {
		expect(promptKey("look", 0)).toBe("look");
		expect(promptKey("look", 2)).toBe("look\n[Image]\n[Image]");
	});

	it("matches a user message without the notes pi adds about an image it resized or converted", () => {
		expect(sentText(" @a.ts look\n[Image]")).toBe("@a.ts look\n[Image]");
		const resized =
			"look\n\n[Image: original 4000x3000, displayed at 2000x1500. Multiply coordinates by 2.00 to map to original image.]\n[Image converted from image/heic to image/png.]\n[Image]\n[Image]";
		expect(sentText(resized)).toBe(promptKey("look", 2));
	});

	it("keeps such a line in a prompt without images", () => {
		expect(sentText("look\n\n[Image: original]")).toBe("look\n\n[Image: original]");
	});
});

describe("a message's text in its bubble", () => {
	const png = { index: 0, mimeType: "image/png" };

	it("leaves out its [Image] lines when its images show instead", () => {
		expect(shownText("look\n[Image]\n[Image]", [png, { ...png, index: 1 }])).toBe("look");
		expect(shownText("Read image file [image/png]\n[Image]", [png])).toBe("Read image file [image/png]");
	});

	it("keeps them without images to show, and keeps a line that only mentions one", () => {
		expect(shownText("look\n[Image]", undefined)).toBe("look\n[Image]");
		expect(shownText("look\n[Image]", [])).toBe("look\n[Image]");
		expect(shownText("see [Image] here\n[Image: original 4000x3000]\n[Image]", [png])).toBe(
			"see [Image] here\n[Image: original 4000x3000]",
		);
	});
});

describe("a sent prompt still waiting once its time is up", () => {
	const sent = { prompt: "fix it", last: "m1" };

	it("fails when the session sat idle and its transcript did not move: it never got there", () => {
		expect(giveUp(sent, "idle", "m1")).toBe("fail");
		expect(giveUp(sent, undefined, "m1")).toBe("fail");
	});

	it("waits while the session works or waits on a dialog, or once it was seen working", () => {
		expect(giveUp(sent, "working", "m1")).toBe("wait");
		expect(giveUp(sent, "needs", "m1")).toBe("wait");
		expect(giveUp({ ...sent, started: true }, "idle", "m1")).toBe("wait");
	});

	it("goes quietly when the transcript moved, as pi wrote it otherwise", () => {
		expect(giveUp(sent, "idle", "m2")).toBe("drop");
	});

	it("goes quietly for a command, which may write nothing", () => {
		expect(giveUp({ prompt: "/reload", last: "m1" }, "idle", "m1")).toBe("drop");
		expect(giveUp({ prompt: "/reload", last: "m1" }, "working", "m1")).toBe("wait");
	});
});

describe("the commands the phone runs itself", () => {
	it("are /compact and /model, typed alone", () => {
		expect(shortcut("/compact")).toBe("compact");
		expect(shortcut(" /model\n")).toBe("model");
	});

	it("leaves anything else to be sent", () => {
		for (const text of ["/compact now", "/models", "/reload", "compact", "/Model", "please /model"]) {
			expect(shortcut(text), text).toBeUndefined();
		}
	});
});

describe("the commands the phone does not send", () => {
	it("are /remote-control and /agent-view, with or without arguments", () => {
		for (const text of ["/remote-control", " /remote-control off\n", "/agent-view", "/agent-view peek"]) {
			expect(refused(text), text).toBe(true);
		}
	});

	it("lets any other line go, a command or a template included", () => {
		for (const text of ["/compact", "/reload", "/review the diff", "run /agent-view", "remote-control", ""]) {
			expect(refused(text), text).toBe(false);
		}
	});
});

describe("a message of yours for the reply box or the clipboard", () => {
	it("is its text without the transcript's [Image] lines", () => {
		expect(promptText("look at these\n[Image]\n[Image]")).toBe("look at these");
		expect(promptText("see [Image] here\n\n[Image: original 4000x3000]")).toBe(
			"see [Image] here\n\n[Image: original 4000x3000]",
		);
	});
});
