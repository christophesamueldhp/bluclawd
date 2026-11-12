import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { contentText, fauxAssistantMessage, fauxProvider, type TranscriptContext } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionFactory,
	type ExtensionUIContext,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import photon from "@silvia-odwyer/photon-node";
import { afterEach, describe, expect, it } from "vitest";
import paste, { PasteEditor } from "../ext/paste/index.ts";
import skills from "../ext/skills/index.ts";
import { waitFor } from "./helpers/wait-for.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
});

/** The mounted paste/skill editor submits into a real, isolated session, as the TUI does. */
async function composer(mode: "tui" | "rpc" = "tui") {
	const cwd = mkdtempSync(join(tmpdir(), "bluclawd-skill-session-"));
	cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
	const paths = Object.fromEntries(
		["review", "plan"].map((name) => {
			const path = join(cwd, "skills", name, "SKILL.md");
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(
				path,
				`---\nname: ${name}\ndescription: Fixture ${name}\n---\n\n${name.toUpperCase()} INSTRUCTIONS. Read references/example.md.\n`,
			);
			return [name, path];
		}),
	);
	const promptPath = join(cwd, "review-template.md");
	writeFileSync(
		promptPath,
		"---\ndescription: Review template\n---\nTemplate first=$1; all=$@; default=${3:-fallback}.",
	);
	const fixedPath = join(cwd, "fixed-template.md");
	writeFileSync(fixedPath, "A fixed template without arguments.");
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(cwd, "auth.json"),
		modelsPath: join(cwd, "models.json"),
		modelsStorePath: join(cwd, "models-store.json"),
		allowModelNetwork: false,
		refreshOnCreate: true,
	});
	const faux = fauxProvider({ provider: "faux-skills" });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.refresh({ allowNetwork: false });
	let api!: ExtensionAPI;
	const commands: string[] = [];
	const capture: ExtensionFactory = (pi) => {
		api = pi;
		pi.registerCommand("fixture-command", {
			description: "Fixture command",
			handler: async (args) => {
				commands.push(args);
			},
		});
	};
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager,
		extensionFactories: [paste, skills, capture],
		additionalSkillPaths: [join(cwd, "skills")],
		additionalPromptTemplatePaths: [promptPath, fixedPath],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		disabledBuiltinExtensions: ["mcp", "codemode", "tool_search"],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		modelRuntime,
		model: faux.getModel(),
		noTools: "builtin",
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager,
	});
	cleanup.push(() => session.dispose());
	const notifications: string[] = [];
	const tui = { requestRender() {}, terminal: { rows: 40, columns: 120 } };
	const theme = {
		borderColor: (s: string) => s,
		selectList: {
			selectedPrefix: (s: string) => s,
			selectedText: (s: string) => s,
			description: (s: string) => s,
			scrollInfo: (s: string) => s,
			noMatch: (s: string) => s,
		},
	};
	const keys = {
		matches: (data: string, action: string) => action === "app.message.followUp" && data === "\x1b\r",
		getKeys: () => [],
	};
	let editor = new PasteEditor(tui as never, theme as never, keys as never);
	let factory: ReturnType<ExtensionUIContext["getEditorComponent"]>;
	let submitted = "";
	let turn: Promise<void> | undefined;
	const ui = {
		getEditorComponent: () => factory,
		setEditorComponent: (next: typeof factory) => {
			factory = next;
			if (next) editor = next(tui as never, theme as never, keys as never) as PasteEditor;
		},
		setEditorText: (text: string) => editor.setText(text),
		notify: (text: string) => notifications.push(text),
		theme: { fg: (_color: string, text: string) => text },
	};
	await session.bindExtensions({ mode, uiContext: ui as unknown as ExtensionUIContext });
	editor.setAutocompleteProvider(new CombinedAutocompleteProvider(api.getCommands(), cwd));
	editor.onSubmit = (text) => {
		submitted = text;
		turn = session.prompt(text, { source: "interactive" });
	};
	const requests: TranscriptContext[] = [];
	const respond = () =>
		faux.appendResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("Done.");
			},
		]);
	const submit = async () => {
		respond();
		editor.handleInput("\x1b");
		editor.handleInput("\r");
		expect(turn).toBeDefined();
		await turn;
	};
	const lastText = () => {
		const user = requests
			.at(-1)
			?.messages.filter((m) => m.role === "user")
			.at(-1);
		return user?.role === "user" ? contentText(user.content) : undefined;
	};
	return {
		cwd,
		session,
		editor,
		faux,
		api,
		paths,
		resourceLoader,
		commands,
		notifications,
		requests,
		respond,
		submit,
		lastText,
		submitted: () => submitted,
	};
}

async function choose(editor: PasteEditor, name = "review") {
	editor.handleInput(`/skill:${name}`);
	await waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
	editor.handleInput("\t");
	expect(editor.getText()).toContain(`[Skill #`);
}

const block = (name: string, path: string) =>
	`<skill name="${name}" location="${path}">\nReferences are relative to ${dirname(path)}.\n\n${name.toUpperCase()} INSTRUCTIONS. Read references/example.md.\n</skill>`;

describe("explicit terminal skills in a real session", () => {
	it.each(["beginning", "middle", "end", "later line"])(
		"loads a selection at the %s with the complete request in one turn",
		async (position) => {
			const c = await composer();
			const before = position === "beginning" ? "" : position === "later line" ? "First line\nPlease " : "Please ";
			const after = position === "end" ? "" : " inspect this";
			c.editor.handleInput(before);
			await choose(c.editor);
			c.editor.handleInput(after);
			await c.submit();
			expect(c.lastText()).toBe(`${block("review", c.paths.review)}\n\n${before}/skill:review${after}`);
			expect(c.requests).toHaveLength(1);
		},
	);

	it("loads only selected skills, once each and in first-selection order, preserving literal references", async () => {
		const c = await composer();
		c.editor.handleInput("/skill:review is a plain reference; use ");
		await choose(c.editor, "plan");
		c.editor.handleInput(" and ");
		await choose(c.editor);
		c.editor.handleInput(" and again ");
		await choose(c.editor, "plan");
		await c.submit();
		expect(c.lastText()).toBe(
			`${block("plan", c.paths.plan)}\n\n${block("review", c.paths.review)}\n\n/skill:review is a plain reference; use /skill:plan and /skill:review and again /skill:plan`,
		);
	});

	it("loads several multiline selections in selection order rather than prompt or alphabetical order", async () => {
		const c = await composer();
		c.editor.handleInput("Discuss /skill:plan; ");
		await choose(c.editor, "review");
		c.editor.handleInput(" at the end");
		c.editor.handleInput("\x01");
		await choose(c.editor, "plan");
		c.editor.handleInput(" first, ");
		c.editor.handleInput("\x05");
		c.editor.handleInput("\n");
		c.editor.handleInput("Then ");
		await choose(c.editor, "review");
		c.editor.handleInput(" alongside ");
		await choose(c.editor, "plan");
		c.editor.handleInput("\x1b[200~ and literal /skill:review.\x1b[201~");
		await c.submit();
		expect(c.lastText()).toBe(
			`${block("review", c.paths.review)}\n\n${block("plan", c.paths.plan)}\n\n/skill:plan first, Discuss /skill:plan; /skill:review at the end\nThen /skill:review alongside /skill:plan and literal /skill:review.`,
		);
		expect(c.requests).toHaveLength(1);
		expect(c.requests[0].messages.filter((message) => message.role === "user")).toHaveLength(1);
	});

	it.each(["last duplicate", "all duplicates"])(
		"loads only remaining selections after removing %s from a mixed multiline draft",
		async (removed) => {
			const c = await composer();
			c.editor.handleInput("/skill:plan is literal; ");
			await choose(c.editor, "plan");
			c.editor.handleInput(" with ");
			await choose(c.editor, "review");
			c.editor.handleInput("\n");
			c.editor.handleInput("repeat ");
			await choose(c.editor, "plan");
			c.editor.handleInput("\x7f");
			if (removed === "all duplicates") {
				c.editor.handleInput("\x01");
				c.editor.handleInput("\x1b[D");
				c.editor.handleInput("\x1b[D");
				for (let i = 0; i < 6; i++) c.editor.handleInput("\x1b[D");
				c.editor.handleInput("\x7f");
			}
			c.editor.handleInput("edited");
			await c.submit();
			const instructions =
				removed === "all duplicates"
					? block("review", c.paths.review)
					: `${block("plan", c.paths.plan)}\n\n${block("review", c.paths.review)}`;
			const request =
				removed === "all duplicates"
					? "/skill:plan is literal; edited with /skill:review\nrepeat"
					: "/skill:plan is literal; /skill:plan with /skill:review\nrepeat edited";
			expect(c.lastText()).toBe(`${instructions}\n\n${request}`);
			expect(c.requests).toHaveLength(1);
		},
	);

	it("keeps the selection when inserting text before and after it", async () => {
		const c = await composer();
		await choose(c.editor);
		c.editor.handleInput(" afterwards");
		c.editor.handleInput("\x01");
		c.editor.handleInput("Before ");
		await c.submit();
		expect(c.lastText()).toBe(`${block("review", c.paths.review)}\n\nBefore /skill:review afterwards`);
	});

	it.each(["[", "]"])("keeps a selection when inserting its delimiter %s beside it", async (delimiter) => {
		const c = await composer();
		await choose(c.editor);
		if (delimiter === "[") c.editor.handleInput("\x01");
		c.editor.handleInput(delimiter);
		await c.submit();
		const request = delimiter === "[" ? "[/skill:review" : "/skill:review]";
		expect(c.lastText()).toBe(`${block("review", c.paths.review)}\n\n${request}`);
	});

	it.each([false, true])(
		"preserves selection semantics through the Alt+Enter submission path (selected=%s)",
		async (selected) => {
			const c = await composer();
			if (selected) {
				c.editor.handleInput("Please ");
				await choose(c.editor);
			} else c.editor.handleInput("/skill:review literal");
			c.editor.handleInput("\x1b");
			c.respond();
			let followUp: Promise<void> | undefined;
			c.editor.actionHandlers.set("app.message.followUp", () => {
				// InteractiveMode.handleFollowUp expands before clearing and submitting the draft.
				const text = c.editor.getExpandedText().trim();
				c.editor.setText("");
				followUp = c.session.prompt(text, { source: "interactive" });
			});
			c.editor.handleInput("\x1b\r");
			expect(followUp).toBeDefined();
			await followUp;
			expect(c.lastText()?.trimStart()).toBe(
				selected ? `${block("review", c.paths.review)}\n\nPlease /skill:review` : "/skill:review literal",
			);
		},
	);

	it("does not transfer a deleted selection onto an adjacent pasted marker copy", async () => {
		const c = await composer();
		await choose(c.editor);
		const marker = c.editor.getText();
		c.editor.handleInput(`\x1b[200~${marker}\x1b[201~`);
		c.editor.handleInput("\x01");
		c.editor.handleInput("\x1b[3~");
		expect(c.editor.getText()).toBe(marker);
		await c.submit();
		expect(c.lastText()).toBe(marker);
	});

	it("preserves edited surrounding text and cancels a deleted selection", async () => {
		const c = await composer();
		c.editor.handleInput("Please ");
		await choose(c.editor);
		c.editor.handleInput("\x7f");
		c.editor.handleInput("discuss /skill:review");
		await c.submit();
		expect(c.lastText()).toBe("Please discuss /skill:review");
	});

	it("does not activate a plain leading reference alongside another selected skill", async () => {
		const c = await composer();
		c.editor.handleInput("/skill:review discuss this using ");
		await choose(c.editor, "plan");
		await c.submit();
		expect(c.lastText()).toBe(`${block("plan", c.paths.plan)}\n\n/skill:review discuss this using /skill:plan`);
	});

	it.each(["typed", "pasted", "collapsed paste"])(
		"keeps a %s leading skill reference as model-visible text",
		async (kind) => {
			const c = await composer();
			const text = `/skill:review discuss this${kind === "collapsed paste" ? "\nMore text".repeat(15) : ""}`;
			c.editor.handleInput(kind === "typed" ? text : `\x1b[200~${text}\x1b[201~`);
			await c.submit();
			expect(c.lastText()?.trimStart()).toBe(text);
			expect(c.lastText()).not.toContain("REVIEW INSTRUCTIONS");
		},
	);

	it("delivers pasted text and image content together with the selected instructions", async () => {
		const c = await composer();
		await choose(c.editor);
		const text = "\nPasted reference /skill:plan".repeat(11);
		c.editor.handleInput(`\x1b[200~${text}\x1b[201~`);
		c.editor.handleInput(" ");
		const image = join(c.cwd, "pi-clipboard-fixture.png");
		const pixel = new photon.PhotonImage(new Uint8Array([255, 255, 255, 255]), 1, 1);
		const bytes = Buffer.from(pixel.get_bytes());
		pixel.free();
		writeFileSync(image, bytes);
		c.editor.insertTextAtCursor(image);
		await c.submit();
		expect(c.lastText()).toContain(`${block("review", c.paths.review)}\n\n/skill:review${text} [Image #1]`);
		const user = c.requests
			.at(-1)
			?.messages.filter((m) => m.role === "user")
			.at(-1);
		expect(user?.role === "user" && user.content).toContainEqual({
			type: "image",
			data: bytes.toString("base64"),
			mimeType: "image/png",
		});
	});

	it("does not reactivate a withdrawn queued selection when its plain text is restored and resubmitted", async () => {
		const c = await composer();
		const submit = c.editor.onSubmit;
		let queued = "";
		c.editor.onSubmit = (text) => {
			queued = text;
			// The TUI queues raw text during compaction, before session input hooks run.
			c.editor.setText("");
		};
		await choose(c.editor);
		c.editor.handleInput(" inspect");
		c.editor.handleInput("\r");
		expect(queued).toBe("/skill:review inspect");
		// Dequeue restores the queued text, not the original selected marker.
		c.editor.setText(queued);
		expect(c.editor.render(120).join("\n")).not.toContain("Selected skill");
		c.editor.onSubmit = submit;
		await c.submit();
		expect(c.lastText()?.trimStart()).toBe("/skill:review inspect");
	});

	it("keeps identities when several terminal submissions wait before session delivery", async () => {
		const c = await composer();
		const queued: string[] = [];
		c.editor.onSubmit = (text) => {
			queued.push(text);
		};
		await choose(c.editor);
		c.editor.handleInput(" first");
		c.editor.handleInput("\r");
		c.editor.handleInput("/skill:plan literal second");
		c.editor.handleInput("\x1b");
		c.editor.handleInput("\r");
		for (const text of queued) {
			c.respond();
			await c.session.prompt(text, { source: "interactive" });
		}
		const texts = c.requests.map((request) =>
			contentText(request.messages.filter((message) => message.role === "user").at(-1)?.content ?? ""),
		);
		expect(texts[0]).toBe(`${block("review", c.paths.review)}\n\n/skill:review first`);
		expect(texts[1]?.trimStart()).toBe("/skill:plan literal second");
	});

	it("keeps programmatic expansion unchanged while another terminal submission awaits delivery", async () => {
		const c = await composer();
		await choose(c.editor, "plan");
		c.editor.onSubmit = () => {};
		c.editor.handleInput("\r");
		c.respond();
		await c.session.prompt("/skill:review programmatic", { source: "extension" });
		expect(c.lastText()).toBe(`${block("review", c.paths.review)}\n\nprogrammatic`);
		c.respond();
		await c.session.prompt("/skill:review no editor submission", { source: "interactive" });
		expect(c.lastText()).toBe(`${block("review", c.paths.review)}\n\nno editor submission`);
	});

	it("does not change RPC skill expansion", async () => {
		const c = await composer("rpc");
		c.respond();
		await c.session.prompt("/skill:review rpc", { source: "rpc" });
		expect(c.lastText()).toBe(`${block("review", c.paths.review)}\n\nrpc`);
	});

	it("preserves non-skill commands and ordinary prompt templates", async () => {
		const c = await composer();
		c.editor.handleInput("/fixture-command argument");
		await c.submit();
		expect(c.commands).toEqual(["argument"]);
		expect(c.requests).toHaveLength(0);
		c.editor.handleInput('/review-template "two words" second');
		await c.submit();
		expect(c.lastText()).toBe("Template first=two words; all=two words second; default=fallback.");
	});

	it.each(["review-template", "fixed-template"])("preserves /%s expansion alongside a selection", async (name) => {
		const c = await composer();
		c.editor.handleInput(`/${name} "two words" `);
		await choose(c.editor);
		await c.submit();
		const request =
			name === "fixed-template"
				? "A fixed template without arguments."
				: "Template first=two words; all=two words /skill:review; default=fallback.";
		expect(c.lastText()).toBe(`${block("review", c.paths.review)}\n\n${request}`);
	});

	it("refuses the whole submission when a selected instruction file becomes unavailable", async () => {
		const c = await composer();
		await choose(c.editor);
		rmSync(c.paths.review);
		await c.submit();
		expect(c.requests).toHaveLength(0);
		expect(c.notifications.join("\n")).toContain("review");
		expect(c.notifications.join("\n")).toContain(c.paths.review);
	});

	it("refuses an old identity when discovery now points the same name at another file", async () => {
		const c = await composer();
		await choose(c.editor);
		const discovered = c.resourceLoader.getSkills().skills.find((skill) => skill.name === "review")!;
		discovered.sourceInfo = { ...discovered.sourceInfo, path: c.paths.plan };
		await c.submit();
		expect(c.requests).toHaveLength(0);
		expect(c.notifications.join("\n")).toContain("review");
	});
});
