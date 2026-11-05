import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { contentText, fauxAssistantMessage, fauxProvider, type TranscriptContext } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import photon from "@silvia-odwyer/photon-node";
import { afterEach, expect, it, vi } from "vitest";
import { createSkillDraft } from "#remote-web/skills.js";
import type { PaneMessage } from "../daemon/ipc/protocol.ts";
import { OrchestratorClient } from "../daemon/orchestrator-client.ts";
import { startRemoteServer } from "../daemon/remote/http.ts";
import { RemoteStore } from "../daemon/remote/pairing.ts";
import { PANE_ENV } from "../daemon/tmux.ts";
import remote from "../ext/remote/index.ts";
import { paneCommands } from "../ext/remote/report.ts";
import { waitFor } from "./helpers/wait-for.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
	vi.restoreAllMocks();
});

async function chat() {
	const cwd = mkdtempSync(join(tmpdir(), "bluclawd-remote-skills-"));
	cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
	const paths = Object.fromEntries(
		["review", "plan"].map((name) => {
			const path = join(cwd, "skills", name, "SKILL.md");
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(
				path,
				`---\nname: ${name}\ndescription: Fixture ${name}\n---\n${name.toUpperCase()} INSTRUCTIONS. Read references/example.md.`,
			);
			return [name, path];
		}),
	);
	const runtime = await ModelRuntime.create({
		authPath: join(cwd, "auth.json"),
		modelsPath: join(cwd, "models.json"),
		modelsStorePath: join(cwd, "store.json"),
		allowModelNetwork: false,
		refreshOnCreate: true,
	});
	const faux = fauxProvider({ provider: "faux-remote-skills" });
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	let api: ExtensionAPI | undefined;
	const sent = vi.spyOn(OrchestratorClient.prototype, "remoteReport").mockResolvedValue();
	vi.stubEnv(PANE_ENV, "pi-skills");
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager,
		extensionFactories: [
			remote,
			(pi) => {
				api = pi;
			},
		],
		additionalSkillPaths: [join(cwd, "skills")],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		disabledBuiltinExtensions: ["mcp", "codemode", "tool_search"],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		modelRuntime: runtime,
		model: faux.getModel(),
		noTools: "builtin",
		resourceLoader: loader,
		sessionManager: SessionManager.create(cwd, join(cwd, "sessions")),
		settingsManager,
	});
	cleanup.push(() => session.dispose());
	await session.bindExtensions({ mode: "tui" });
	if (!api) throw new Error("no extension");
	const extension = api;
	let commands = paneCommands(extension);
	const report = () => ({ models: [], commands, outcomes: sent.mock.lastCall?.[1].outcomes ?? [] });
	const store = new RemoteStore(join(cwd, "remote.json"));
	const transported: PaneMessage[] = [];
	const server = await startRemoteServer(
		{
			store,
			webDir: join(import.meta.dirname, "../daemon/remote/web"),
			listInstances: () => [
				{
					id: "target",
					status: "online",
					cwd,
					external: true,
					pane: "pi-skills",
					sessionFile: session.sessionFile,
				},
			],
			report,
			outcomes: () => report().outcomes,
			send: (_id, message) => {
				transported.push(message);
				extension.events.emit("bluclawd:pane-message", message);
				return true;
			},
			launch: () => undefined,
			startSession: () => "unused",
			claimStart: () => ({ ok: true, id: "unused" }),
			paneStarting: () => {},
			startFailed: () => {},
			terminalOpen: () => true,
			renameInstance: () => true,
			setPinned: () => true,
			deleteInstance: () => true,
		},
		0,
	);
	cleanup.push(() => server.close());
	const base = `http://127.0.0.1:${server.port}`;
	const paired = await fetch(`${base}/api/pair`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code: store.createCode().code, deviceName: "fixture" }),
	});
	const { token } = (await paired.json()) as { token: string };
	const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
	const discovered = await fetch(`${base}/api/sessions/target/commands`, { headers });
	commands = (await discovered.json()).commands;
	const requests: TranscriptContext[] = [];
	const submit = async (draft: ReturnType<typeof createSkillDraft>, extra = {}) => {
		faux.appendResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("Done.");
			},
		]);
		const before = requests.length;
		const res = await fetch(`${base}/api/sessions/target/prompt`, {
			method: "POST",
			headers,
			body: JSON.stringify({ ...draft.submit(), id: `p-${transported.length}`, ...extra }),
		});
		expect(res.status).toBe(202);
		await waitFor(() => expect(requests.length).toBe(before + 1));
		await waitFor(() => expect(session.isIdle).toBe(true));
		const user = requests
			.at(-1)
			?.messages.filter((m) => m.role === "user")
			.at(-1);
		return user?.role === "user" ? contentText(user.content) : "";
	};
	return { commands, paths, submit, requests, transported, session, headers, base, loader };
}

it("sends Chat's explicitly chosen skill with its multiline request through HTTP to the target model", async () => {
	const c = await chat();
	const draft = createSkillDraft();
	draft.edit("Please\n/skill:rev", 0, 17);
	const review = c.commands.find((c) => c.name === "skill:review");
	if (!review) throw new Error("no review");
	draft.choose(review, 7, draft.text.length);
	expect(draft.selectedHtml()).toContain(c.paths.review);
	const text = await c.submit(draft);
	expect(text).toBe(
		`<skill name="review" location="${c.paths.review}">\nReferences are relative to ${dirname(c.paths.review)}.\n\nREVIEW INSTRUCTIONS. Read references/example.md.\n</skill>\n\nPlease\n/skill:review`,
	);
	expect(c.requests).toHaveLength(1);
	expect(c.transported[0]).toMatchObject({ type: "prompt", sessionFile: c.session.sessionFile });
});

/** Choose via the same caret suggestions as the Chat autocomplete. */
function choose(c: Awaited<ReturnType<typeof chat>>, draft: ReturnType<typeof createSkillDraft>, name: string) {
	const before = draft.text.length;
	draft.edit(`${draft.text}/skill:${name}`, before, before + 7 + name.length);
	const suggestion = draft.suggestions(c.commands, draft.text.length).find((s) => s.command.name === `skill:${name}`);
	if (!suggestion) throw new Error(`No suggestion for ${name}`);
	draft.choose(suggestion.command, suggestion.start, suggestion.end);
}

it("loads distinct skills in first-selection order despite duplicates, text edits and marker removal", async () => {
	const c = await chat();
	const draft = createSkillDraft();
	choose(c, draft, "review");
	draft.edit(`${draft.text} between\n`, draft.text.length, draft.text.length + 9);
	choose(c, draft, "plan");
	draft.edit(`${draft.text} and `, draft.text.length, draft.text.length + 5);
	choose(c, draft, "review");
	// Prepending another selection changes text order, not first-selection order.
	const plan = c.commands.find((c) => c.name === "skill:plan");
	if (!plan) throw new Error("no plan");
	draft.choose(plan, 0, 0);
	draft.remove(1); // Cancel the first plan; the later choice still remains.
	draft.edit(`Before ${draft.text}`, 0, 7);
	draft.edit(`${draft.text} after /skill:unselected`, draft.text.length, draft.text.length + 24);
	const text = await c.submit(draft);
	expect(text.match(/<skill name="review"/g)).toHaveLength(1);
	expect(text.match(/<skill name="plan"/g)).toHaveLength(1);
	expect(text.indexOf('name="review"')).toBeLessThan(text.indexOf('name="plan"'));
	expect(text).toContain("Before /skill:plan/skill:review between\n and /skill:review after /skill:unselected");
	expect(text).not.toContain("[Skill #");
	expect(c.requests).toHaveLength(1);
});

it.each(["/skill:review typed at the start", "Pasted\n/skill:review and /skill:plan"])(
	"keeps literal references as text: %s",
	async (literal) => {
		const c = await chat();
		const draft = createSkillDraft();
		draft.edit(literal, 0, literal.length);
		const text = await c.submit(draft);
		expect(text.trimStart()).toBe(literal);
		expect(text).not.toContain("INSTRUCTIONS");
		expect(c.transported[0]).toMatchObject({ type: "prompt", skills: [] });
	},
);

it("cancels activation when a marker is deleted then pasted back as ordinary text", async () => {
	const c = await chat();
	const draft = createSkillDraft();
	choose(c, draft, "review");
	const marker = draft.text;
	draft.edit("", marker.length, 0);
	draft.edit(marker, 0, marker.length);
	expect(draft.selectedHtml()).toBe("");
	const text = await c.submit(draft);
	expect(text).toBe(marker);
	expect(text).not.toContain("INSTRUCTIONS");
});

it("keeps images and only the remaining explicitly chosen skill in one turn", async () => {
	const c = await chat();
	const draft = createSkillDraft();
	choose(c, draft, "review");
	draft.edit(`${draft.text}\n`, draft.text.length, draft.text.length + 1);
	choose(c, draft, "plan");
	draft.remove(0);
	draft.edit(`${draft.text} /skill:review literal`, draft.text.length, draft.text.length + 22);
	const text = await c.submit(draft, {
		images: [
			{
				mimeType: "image/png",
				data: Buffer.from(new photon.PhotonImage(new Uint8Array([255, 255, 255, 255]), 1, 1).get_bytes()).toString(
					"base64",
				),
			},
		],
	});
	expect(text).toContain("PLAN INSTRUCTIONS");
	expect(text).not.toContain("REVIEW INSTRUCTIONS");
	expect(text).toContain("/skill:review literal");
	const user = c.requests[0]?.messages.filter((m) => m.role === "user").at(-1);
	expect(user?.role === "user" && user.content).toEqual(
		expect.arrayContaining([expect.objectContaining({ type: "image", mimeType: "image/png" })]),
	);
});

it("refuses the whole prompt when discovery no longer resolves a selected identity", async () => {
	const c = await chat();
	const draft = createSkillDraft();
	choose(c, draft, "review");
	const skill = c.loader.getSkills().skills.find((s) => s.name === "review");
	if (!skill) throw new Error("no skill");
	skill.sourceInfo = { ...skill.sourceInfo, path: c.paths.plan };
	const res = await fetch(`${c.base}/api/sessions/target/prompt`, {
		method: "POST",
		headers: c.headers,
		body: JSON.stringify({ ...draft.submit(), id: "stale" }),
	});
	expect(res.status).toBe(202);
	await waitFor(async () => {
		const status = await fetch(`${c.base}/api/sessions/target/status`, { headers: c.headers });
		expect(await status.json()).toMatchObject({
			report: { outcomes: [{ id: "stale", outcome: "refused", reason: "invalid_skills" }] },
		});
	});
	expect(c.requests).toHaveLength(0);
	expect(c.session.messages).toHaveLength(0);
});

it.each([["/tmp/SKILL.md"], [{ id: "a".repeat(64), path: "/tmp/SKILL.md", content: "INJECTED" }], ["a".repeat(64)]])(
	"refuses client paths, contents or undiscovered identities: %j",
	async (skills) => {
		const c = await chat();
		const res = await fetch(`${c.base}/api/sessions/target/prompt`, {
			method: "POST",
			headers: c.headers,
			body: JSON.stringify({ text: "hello", skills: [skills] }),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "invalid_skills" });
		expect(c.transported).toHaveLength(0);
	},
);
