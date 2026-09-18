/**
 * Holes in gates that already exist, each found by running the evaluator directly:
 * a credential read through bash or a recursive grep, an "Always allow" whose `*`
 * stayed a live glob, an allow glob that cleared command substitution, `/permissions
 * add` dropping the session's flag-derived rules, and tools no rule verb names
 * prompting with a `null` subject.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type EvalConfig, evaluatePostHook, evaluatePreHook } from "../ext/permissions/evaluate.ts";
import permissions from "../ext/permissions/index.ts";
import { commandPrefix, decide, exactRule, parseRuleSpec, standingRules } from "../ext/permissions/rules.ts";

const agentDir = "/home/u/.pi/agent";
const cwd = "/proj";
const plain = { bold: (t: string) => t, fg: (_c: string, t: string) => t };

function cfg(over: Partial<EvalConfig> = {}): EvalConfig {
	return {
		mode: "auto",
		rules: {},
		cliAllowRules: {},
		cwd,
		agentDir,
		configDirName: ".bluclawd",
		hasUI: true,
		...over,
	};
}

function verdict(tool: string, input: Record<string, unknown>, c: EvalConfig = cfg()) {
	return evaluatePreHook(tool, input, c) ?? evaluatePostHook(tool, input, c);
}

describe("A1: bash reads of credential files meet the protected-read gate", () => {
	it.each([
		"cat /home/u/.pi/agent/auth.json",
		"head -5 '/home/u/.pi/agent/mcp.json'",
		"cat .mcp.json",
		"python3 dump.py < .bluclawd/settings.json",
		"grep -r token /home/u/.pi/agent/*.json",
		"base64 --input=/home/u/.pi/agent/auth.json",
	])("%s prompts in auto mode", (command) => {
		const v = verdict("bash", { command });
		expect(v.outcome).toBe("prompt");
		expect(v.gate).toBe("read-protected-path");
		// The prompt names the whole command: approving it approves all of it.
		expect(v.reason).toContain(command);
		// A word is all the screen sees, so it cannot claim the command reads the file.
		expect(v.reason).toContain("names");
	});

	it("blocks headless", () => {
		expect(verdict("bash", { command: "cat .mcp.json" }, cfg({ hasUI: false })).outcome).toBe("block");
	});

	it("leaves ordinary reads alone", () => {
		for (const command of ["cat package.json", "cat src/auth.json", "ls /home/u/.pi/agent", "echo settings.json"]) {
			expect(verdict("bash", { command }).gate).not.toBe("read-protected-path");
		}
	});

	it("puts a command that both reads and writes protected files through the write prompt", () => {
		// An approved protected READ falls through to the later gates; a protected write
		// must not ride along on it.
		expect(verdict("bash", { command: "cat .mcp.json > .bluclawd/hooks.json" }).gate).toBe("write-protected-path");
	});

	it("is cleared by the exact rule 'Always allow' persists", () => {
		const command = "cat .mcp.json";
		const allow = [exactRule("bash", command) as string];
		expect(verdict("bash", { command }, cfg({ rules: { allow } })).outcome).toBe("allow");
	});
});

describe("A2: grep over a tree that holds credentials", () => {
	it.each([
		["the agent dir", "~/.pi/agent"],
		["inside the agent dir", "~/.pi/agent/extensions"],
		["an ancestor of the agent dir", "~"],
		["the project config dir", ".bluclawd"],
	])("prompts for %s", (_label, path) => {
		const v = verdict("grep", { pattern: "key", path }, cfg({ agentDir: "~/.pi/agent" }));
		expect(v.outcome).toBe("prompt");
		expect(v.gate).toBe("read-protected-path");
	});

	it("does not prompt for an ordinary project search", () => {
		expect(verdict("grep", { pattern: "key" }).outcome).toBe("allow");
		expect(verdict("grep", { pattern: "key", path: "src" }).outcome).toBe("allow");
	});

	it("leaves find and ls alone: they list names, not contents", () => {
		expect(verdict("ls", { path: "/home/u/.pi/agent" }).outcome).toBe("allow");
		expect(verdict("find", { pattern: "*.json", path: "/home/u/.pi/agent" }).outcome).toBe("allow");
	});
});

describe("A3: an exact rule is exact", () => {
	it("escapes * so an 'Always allow' cannot become a glob", () => {
		const rule = exactRule("bash", "ls *.ts") as string;
		expect(decide({ allow: [rule] }, "bash", { command: "ls *.ts" }, cwd)).toBe("allow");
		expect(decide({ allow: [rule] }, "bash", { command: "ls src/evil.ts" }, cwd)).toBeNull();
		expect(
			decide({ allow: [exactRule("edit", "src/*.ts") as string] }, "edit", { path: "src/a.ts" }, cwd),
		).toBeNull();
	});

	it("round-trips through parseRuleSpec to the original command", () => {
		for (const command of ["ls *.ts", "echo \\*", "rm x"]) {
			expect(parseRuleSpec(exactRule("bash", command) as string)?.input.command).toBe(command);
		}
	});

	it("keeps an unescaped * a glob in rules people write", () => {
		expect(decide({ allow: ["Bash(npm run *)"] }, "bash", { command: "npm run build" }, cwd)).toBe("allow");
	});
});

describe("A4: allow globs do not clear command substitution", () => {
	it.each(["git $(rm -rf ~)", "git log `curl x|sh`", "git diff <(cat /etc/passwd)", "git status && git log $(id)"])(
		"%s is not allowed by Bash(git *)",
		(command) => {
			expect(decide({ allow: ["Bash(git *)"] }, "bash", { command }, cwd)).toBeNull();
			expect(verdict("bash", { command }, cfg({ mode: "ask", rules: { allow: ["Bash(git *)"] } })).outcome).toBe(
				"prompt",
			);
		},
	);

	it("is still allowed by the exact rule the user approved", () => {
		const command = "echo $(date)";
		expect(decide({ allow: [exactRule("bash", command) as string] }, "bash", { command }, cwd)).toBe("allow");
	});

	it("does not weaken deny", () => {
		expect(decide({ deny: ["Bash(git *)"] }, "bash", { command: "git $(x)" }, cwd)).toBe("deny");
	});
});

describe("prefix rules (`Bash(npm test:*)`)", () => {
	const allow = (command: string) => decide({ allow: ["Bash(npm test:*)"] }, "bash", { command }, cwd);

	it("match the prefix alone or with arguments, not a longer word", () => {
		expect(allow("npm test")).toBe("allow");
		expect(allow("npm test -- --watch")).toBe("allow");
		expect(allow("npm testx")).toBeNull();
		expect(allow("npm tes")).toBeNull();
	});

	it("do not allow command substitution or another command in the line", () => {
		expect(allow("npm test $(rm -rf ~)")).toBeNull();
		expect(allow("npm test `rm -rf ~`")).toBeNull();
		expect(allow("npm test && rm -rf /")).toBeNull();
		expect(allow("npm test; rm -rf /")).toBeNull();
	});

	it("work for deny too", () => {
		expect(decide({ deny: ["Bash(rm:*)"] }, "bash", { command: "rm -rf x" }, cwd)).toBe("deny");
		expect(decide({ deny: ["Bash(rm:*)"] }, "bash", { command: "env A=1 rm x" }, cwd)).toBe("deny");
	});
});

describe("what don't ask again grants", () => {
	it("offers a command's prefix, with the subcommand where the tool has one", () => {
		expect(commandPrefix("npm test -- --watch")).toBe("npm test");
		expect(commandPrefix("npm run build --prod")).toBe("npm run build");
		expect(commandPrefix("git push origin main")).toBe("git push");
		expect(commandPrefix("ls -la")).toBe("ls");
	});

	it("offers no prefix for interpreters, wrappers or substitution", () => {
		for (const command of [
			"python x.py",
			"bash -c 'rm x'",
			"sudo rm x",
			"env A=1 rm x",
			"./run.sh",
			"git $(x)",
			"git --no-pager log",
			"git -C /x status",
			"npm --prefix x run evil",
		]) {
			expect(commandPrefix(command)).toBeUndefined();
		}
	});

	it("grants one rule per segment, the exact command where no prefix is safe", () => {
		expect(standingRules("bash", "npm test && python x.py")).toEqual(["Bash(npm test:*)", "Bash(python x.py)"]);
		expect(standingRules("bash", "ls *.ts")).toEqual(["Bash(ls:*)"]);
		expect(standingRules("webfetch", "https://docs.rs/x?y=1")).toEqual(["WebFetch(domain:docs.rs)"]);
		expect(standingRules("some_tool", "x")).toEqual([]);
	});
});

describe("A6: tools no rule verb names", () => {
	it("runs background-bash control tools without a prompt, like the task control tools", () => {
		for (const tool of ["bash_output", "kill_bash"]) {
			expect(verdict(tool, { id: "bash_1" }, cfg({ mode: "ask" })).outcome).toBe("allow");
		}
	});

	it("treats local reads of stored web content as reads", () => {
		for (const tool of ["get_search_content", "source_check"]) {
			expect(verdict(tool, { id: "x" }, cfg({ mode: "ask" })).outcome).toBe("allow");
		}
	});

	it("governs MCP resource tools by their server", () => {
		const rules = { deny: ["Mcp(github:*)"] };
		expect(verdict("mcp_read_resource", { server: "github", uri: "repo://x" }, cfg({ rules })).outcome).toBe("block");
		expect(verdict("mcp_list_resources", { server: "github" }, cfg({ rules })).outcome).toBe("block");
		expect(verdict("mcp_read_resource", { server: "docs", uri: "d://x" }, cfg({ rules })).outcome).toBe("allow");
	});

	it("never prompts with a null subject", () => {
		for (const tool of ["memory", "mcp_find_tools", "some_extension_tool"]) {
			const v = verdict(tool, {}, cfg({ mode: "ask" }));
			expect(v.reason).not.toContain("null");
			if (v.outcome === "prompt") expect(v.reason).toContain(tool);
		}
	});
});

describe("A5: /permissions add keeps the session's flag-derived rules", () => {
	let home: string;
	let dir: string;
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "bluclawd-perm-home-"));
		dir = mkdtempSync(join(tmpdir(), "bluclawd-perm-cwd-"));
		saved.HOME = process.env.HOME;
		saved.PI_PERMISSION_MODE = process.env.PI_PERMISSION_MODE;
		for (const key of Object.keys(process.env)) {
			if (key.endsWith("_CODING_AGENT_DIR")) {
				saved[key] = process.env[key];
				delete process.env[key];
			}
		}
		process.env.HOME = home;
		mkdirSync(getAgentDir(), { recursive: true });
		writeFileSync(join(getAgentDir(), "settings.json"), JSON.stringify({ permissions: {} }));
	});
	afterEach(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(home, { recursive: true, force: true });
		rmSync(dir, { recursive: true, force: true });
	});

	function load(flags: Record<string, unknown>) {
		const handlers: Record<string, (event: any, ctx: any) => Promise<any>> = {};
		const commands: Record<string, (args: string, ctx: any) => Promise<void>> = {};
		const descriptions: Record<string, string> = {};
		const entries: any[] = [];
		const notes: string[] = [];
		let renderer: any;
		const pi = {
			registerFlag: () => {},
			getFlag: (name: string) => flags[name],
			on: (event: string, handler: any) => {
				handlers[event] = handler;
			},
			registerCommand: (name: string, def: any) => {
				commands[name] = def.handler;
				descriptions[name] = def.description;
			},
			registerShortcut: () => {},
			registerEntryRenderer: (_type: string, r: any) => {
				renderer = r;
			},
			appendEntry: (_type: string, data: any) => entries.push(data),
		} as any;
		permissions(pi);
		const ctx = {
			cwd: dir,
			hasUI: false,
			isProjectTrusted: () => true,
			ui: {
				notify: (text: string) => notes.push(text),
				setStatus: () => {},
				theme: { fg: (_c: string, t: string) => t },
			},
		};
		return {
			handlers,
			commands,
			ctx,
			descriptions,
			entries,
			notes,
			render: (data: any) => renderer({ data }, {}, plain),
		};
	}

	it("keeps --disallowedTools deny rules after a rule is added", async () => {
		const { handlers, commands, ctx } = load({ disallowedTools: "Bash(curl **)" });
		await handlers.session_start({}, ctx);
		const call = { toolName: "bash", input: { command: "curl https://x" } };
		expect((await handlers.tool_call(call, ctx))?.block).toBe(true);

		await commands.permissions('add allow "Bash(npm test)"', ctx);
		expect(JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")).permissions.allow).toContain(
			"Bash(npm test)",
		);
		const after = await handlers.tool_call(call, ctx);
		expect(after?.block).toBe(true);
		expect(after?.reason).toContain("deny");
	});

	it("keeps the PI_PERMISSION_MODE=ask posture after a rule is removed", async () => {
		process.env.PI_PERMISSION_MODE = "ask";
		const { handlers, commands, ctx } = load({});
		await handlers.session_start({}, ctx);
		const call = { toolName: "write", input: { path: "a.txt", content: "" } };
		// Headless, so the ask-all rule turns into a block.
		expect((await handlers.tool_call(call, ctx))?.block).toBe(true);
		await commands.permissions('remove "Bash(nothing)"', ctx);
		expect((await handlers.tool_call(call, ctx))?.block).toBe(true);
	});
	it("offers a protected read for the session, and does not ask again once chosen", async () => {
		const { handlers, ctx } = load({});
		const { live, seen } = interactive(ctx, [/^Yes, allow reading \.mcp\.json during this session$/]);
		await handlers.session_start({}, live);
		const call = { toolName: "bash", input: { command: "git diff .mcp.json" } };
		expect(await handlers.tool_call(call, live)).toBeUndefined();
		expect(await handlers.tool_call(call, live)).toBeUndefined();
		expect(seen).toHaveLength(1);
		expect(projectAllow()).toEqual([]);
	});

	it("/permissions test says the mode decides when no rule matches", async () => {
		const { commands, ctx, entries } = load({});
		await commands.permissions('test "Bash(npm test)"', ctx);
		const text = entries.at(-1).test.join("\n");
		expect(text).not.toContain("the call runs");
		expect(text).toMatch(/mode/);
	});

	it("/permissions test's footnote names only gates that exist", async () => {
		const { commands, ctx, entries, render } = load({});
		await commands.permissions('test "Bash(npm test)"', ctx);
		const text = render(entries.at(-1)).render(200).join("\n");
		expect(text).toContain("RULE decision only");
		expect(text).not.toMatch(/PreToolUse|guardrail/);
	});

	it("/mode's description lists the modes", () => {
		expect(load({}).descriptions.mode).not.toContain("()");
		expect(load({}).descriptions.mode).toContain("ask");
	});

	it("the /permissions usage message mentions test", async () => {
		const { commands, ctx, notes } = load({});
		await commands.permissions("bogus", ctx);
		expect(notes.at(-1)).toContain("test <");
	});

	/** An interactive ctx whose prompts answer from `answers`, in order. */
	/** Answers the prompts in order: a label, or a pattern for the row to pick. */
	function interactive(ctx: any, answers: Array<string | RegExp>, typed?: string, trusted = true) {
		const seen: Array<{ label: string; options: string[] }> = [];
		const ui = {
			...ctx.ui,
			theme: { ...ctx.ui.theme, getColorMode: () => "256" },
			select: async (label: string, options: string[]) => {
				seen.push({ label, options });
				const answer = answers.shift();
				return typeof answer === "string" ? answer : options.find((option) => answer?.test(option));
			},
			input: async () => typed,
		};
		return { live: { ...ctx, hasUI: true, isProjectTrusted: () => trusted, ui }, seen };
	}
	const globalAllow = () =>
		JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")).permissions.allow ?? [];
	const projectAllow = (): string[] => {
		try {
			return JSON.parse(readFileSync(join(dir, CONFIG_DIR_NAME, "settings.json"), "utf8")).permissions.allow ?? [];
		} catch {
			return [];
		}
	};
	const DONT_ASK = /^Yes, and don't ask again for /;

	it("asks as Claude Code does: Yes, don't ask again for the prefix in this project, No", async () => {
		const { handlers, ctx } = load({ "permission-mode": "ask" });
		const { live, seen } = interactive(ctx, ["No"]);
		await handlers.session_start({}, live);
		await handlers.tool_call({ toolName: "bash", input: { command: "npm init -y" } }, live);
		expect(seen[0].label).toBe("Bash command\n\n  npm init -y\n\nDo you want to proceed?");
		expect(seen[0].options).toEqual([
			"Yes",
			`Yes, and don't ask again for npm init commands in ${dir}`,
			"No",
			"No, and tell the model what to do differently",
		]);
	});

	/** A terminal UI: the dialog is drawn, and `keys` are typed into it. */
	function terminal(ctx: any, keys: string[]) {
		const drawn: string[][] = [];
		const ui = {
			...ctx.ui,
			theme: { ...ctx.ui.theme, getColorMode: () => "256" },
			custom: (factory: any) =>
				new Promise((resolve) => {
					const view = factory({ requestRender: () => {} }, plain, {}, resolve);
					drawn.push(view.render(120));
					for (const key of keys) view.handleInput(key);
				}),
			select: async () => {
				throw new Error("a terminal draws the dialog, not the list");
			},
		};
		return { live: { ...ctx, hasUI: true, ui }, drawn };
	}

	it("a terminal gets Claude Code's dialog: a digit picks a row", async () => {
		const { handlers, ctx } = load({ "permission-mode": "ask" });
		const { live, drawn } = terminal(ctx, ["2"]);
		await handlers.session_start({}, live);
		expect(await handlers.tool_call({ toolName: "bash", input: { command: "npm init -y" } }, live)).toBeUndefined();
		expect(drawn[0]).toContain("   3. No");
		expect(projectAllow()).toEqual(["Bash(npm init:*)"]);
	});

	it("a note typed on No reaches the model", async () => {
		const { handlers, ctx } = load({ "permission-mode": "ask" });
		const { live } = terminal(ctx, ["\x1b[B", "\x1b[B", "\t", ..."use pnpm", "\r"]);
		await handlers.session_start({}, live);
		const result = await handlers.tool_call({ toolName: "bash", input: { command: "npm init -y" } }, live);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("The user says: use pnpm");
	});

	it("falls back to the plain list where the dialog cannot be drawn (RPC)", async () => {
		const { handlers, ctx } = load({ "permission-mode": "ask" });
		const { live, seen } = interactive(ctx, ["Yes"]);
		const rpc = { ...live, ui: { ...live.ui, custom: async () => undefined } };
		await handlers.session_start({}, rpc);
		expect(await handlers.tool_call({ toolName: "bash", input: { command: "npm init -y" } }, rpc)).toBeUndefined();
		expect(seen).toHaveLength(1);
	});

	it("don't ask again persists the prefix to the project and covers its arguments", async () => {
		const { handlers, ctx } = load({ "permission-mode": "ask" });
		const { live, seen } = interactive(ctx, [DONT_ASK, "No"]);
		await handlers.session_start({}, live);
		expect(await handlers.tool_call({ toolName: "bash", input: { command: "npm init -y" } }, live)).toBeUndefined();
		expect(projectAllow()).toEqual(["Bash(npm init:*)"]);
		expect(globalAllow()).toEqual([]);
		expect(await handlers.tool_call({ toolName: "bash", input: { command: "npm init" } }, live)).toBeUndefined();
		expect(
			await handlers.tool_call({ toolName: "bash", input: { command: "npm init --scope x" } }, live),
		).toBeUndefined();
		expect(seen).toHaveLength(1);
		// Another word is another command.
		expect((await handlers.tool_call({ toolName: "bash", input: { command: "npm initialize" } }, live))?.block).toBe(
			true,
		);
	});

	it("don't ask again clears the ask rule that asked", async () => {
		writeFileSync(
			join(getAgentDir(), "settings.json"),
			JSON.stringify({ permissions: { ask: ["Bash(git push *)"] } }),
		);
		const { handlers, ctx } = load({});
		const { live, seen } = interactive(ctx, [DONT_ASK]);
		await handlers.session_start({}, live);
		expect(
			await handlers.tool_call({ toolName: "bash", input: { command: "git push origin a" } }, live),
		).toBeUndefined();
		expect(
			await handlers.tool_call({ toolName: "bash", input: { command: "git push origin b" } }, live),
		).toBeUndefined();
		expect(seen).toHaveLength(1);
	});

	it("an edit no rule names offers edits mode instead of a rule", async () => {
		const { handlers, ctx } = load({ "permission-mode": "ask" });
		const { live, seen } = interactive(ctx, [/switch to edits mode/]);
		await handlers.session_start({}, live);
		expect(await handlers.tool_call({ toolName: "edit", input: { path: "a.ts" } }, live)).toBeUndefined();
		expect(seen[0].label).toBe("Edit file\n\n  a.ts\n\nDo you want to proceed?");
		expect(seen[0].options[1]).toBe("Yes, and switch to edits mode for this session (alt+m)");
		expect(await handlers.tool_call({ toolName: "write", input: { path: "b.ts" } }, live)).toBeUndefined();
		expect(seen).toHaveLength(1);
		expect(projectAllow()).toEqual([]);
	});

	it("a protected write offers no standing grant", async () => {
		const { handlers, ctx } = load({});
		const { live, seen } = interactive(ctx, ["No"]);
		await handlers.session_start({}, live);
		await handlers.tool_call({ toolName: "write", input: { path: ".mcp.json" } }, live);
		expect(seen[0].options).toEqual(["Yes", "No", "No, and tell the model what to do differently"]);
	});

	it("an untrusted project keeps don't ask again to the session", async () => {
		const { handlers, ctx } = load({ "permission-mode": "ask" });
		const { live, seen } = interactive(ctx, [DONT_ASK], undefined, false);
		await handlers.session_start({}, live);
		const call = { toolName: "bash", input: { command: "npm test" } };
		expect(await handlers.tool_call(call, live)).toBeUndefined();
		expect(seen[0].options[1]).toBe("Yes, and don't ask again for npm test commands during this session");
		expect(await handlers.tool_call(call, live)).toBeUndefined();
		expect(seen).toHaveLength(1);
		expect(projectAllow()).toEqual([]);
		expect(globalAllow()).toEqual([]);
		// A new session starts without the grant.
		await handlers.session_start({}, live);
		const again = interactive(ctx, ["No"], undefined, false);
		expect((await handlers.tool_call(call, again.live))?.block).toBe(true);
	});

	it("C2: a session grant survives /permissions add", async () => {
		const { handlers, commands, ctx } = load({ "permission-mode": "ask" });
		const { live, seen } = interactive(ctx, [DONT_ASK], undefined, false);
		await handlers.session_start({}, live);
		const call = { toolName: "bash", input: { command: "npm test" } };
		await handlers.tool_call(call, live);
		await commands.permissions('add deny "Bash(curl **)"', live);
		expect(await handlers.tool_call(call, live)).toBeUndefined();
		expect(seen).toHaveLength(1);
	});

	it("C4: No, and tell the model what to do differently passes the note on", async () => {
		const { handlers, ctx } = load({ "permission-mode": "ask" });
		const { live } = interactive(ctx, ["No, and tell the model what to do differently"], "use pnpm instead");
		await handlers.session_start({}, live);
		const result = await handlers.tool_call({ toolName: "bash", input: { command: "npm test" } }, live);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("use pnpm instead");
	});

	it("C6: /permissions why explains recent decisions", async () => {
		const { handlers, commands, ctx, entries, render } = load({ disallowedTools: "Bash(curl **)" });
		await handlers.session_start({}, ctx);
		await handlers.tool_call({ toolName: "bash", input: { command: "git status" } }, ctx);
		await handlers.tool_call({ toolName: "bash", input: { command: "curl https://x" } }, ctx);
		await commands.permissions("why", ctx);
		const text = render(entries.at(-1)).render(200).join("\n");
		expect(text).toMatch(/git status[\s\S]*read-only/);
		expect(text).toMatch(/curl https:\/\/x[\s\S]*deny rule/);
	});

	it("C7: /permissions names where each rule comes from, flags included", async () => {
		writeFileSync(join(getAgentDir(), "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
		const { handlers, commands, ctx, entries, render } = load({
			disallowedTools: "Bash(curl **)",
			allowedTools: "Bash(npm test)",
		});
		await handlers.session_start({}, ctx);
		await commands.permissions("", ctx);
		const text = render(entries.at(-1)).render(200).join("\n");
		expect(text).toMatch(/Bash\(ls\).*global/);
		expect(text).toMatch(/Bash\(curl \*\*\).*--disallowedTools/);
		expect(text).toMatch(/Bash\(npm test\).*--allowedTools/);
	});

	it("C8: /permissions add refuses a verb no gate reads", async () => {
		const { commands, ctx, notes } = load({});
		await commands.permissions('add deny "Shell(rm **)"', ctx);
		expect(notes.at(-1)).toMatch(/Bash/);
		expect(JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")).permissions.deny).toBeUndefined();
	});

	it("C8: /permissions add refuses an empty subject", async () => {
		const { commands, ctx } = load({});
		await commands.permissions('add allow "Bash()"', ctx);
		expect(JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")).permissions.allow).toBeUndefined();
	});

	it("C2: /permissions remove revokes a session grant", async () => {
		const { handlers, commands, ctx } = load({ "permission-mode": "ask" });
		const { live } = interactive(ctx, [DONT_ASK, "No"], undefined, false);
		await handlers.session_start({}, live);
		const call = { toolName: "bash", input: { command: "npm test" } };
		await handlers.tool_call(call, live);
		await commands.permissions('remove "Bash(npm test:*)"', live);
		expect((await handlers.tool_call(call, live))?.block).toBe(true);
	});

	it("C9: don't ask again on a long compound does not ask again", async () => {
		const { handlers, ctx } = load({ "permission-mode": "ask" });
		const { live, seen } = interactive(ctx, [DONT_ASK]);
		await handlers.session_start({}, live);
		const command = "npm run a && npm run b && npm run c && npm run d && npm run e && npm run f";
		const call = { toolName: "bash", input: { command } };
		expect(await handlers.tool_call(call, live)).toBeUndefined();
		expect(await handlers.tool_call(call, live)).toBeUndefined();
		expect(seen).toHaveLength(1);
	});
});

describe("E1: a curl that sends data asks, unless a rule allows it", () => {
	it("prompts in ask mode, and runs once an allow rule names it", () => {
		const input = { command: "curl -d x=1 https://api.example.com" };
		expect(verdict("bash", input, cfg({ mode: "ask" })).outcome).toBe("prompt");
		expect(verdict("bash", input, cfg({ mode: "ask", rules: { allow: ["Bash(curl **)"] } })).outcome).toBe("allow");
	});
});

describe("E2: cp, mv, ln and install into protected paths", () => {
	it.each([
		"cp evil.json .bluclawd/mcp.json",
		"cp -f evil.sh .git/hooks/pre-commit",
		"cp -t .git/hooks evil.sh",
		"cp --target-directory=.git/hooks evil.sh",
		"mv evil.json .mcp.json",
		"mv .bluclawd/settings.json /tmp/x",
		"ln -sf /tmp/evil .git/hooks/pre-commit",
		"install -m 755 evil.sh .git/hooks/pre-push",
		"npm test && /bin/cp evil .git/config",
		"cp evil.json /home/u/.pi/agent/auth.json",
	])("%s asks as a protected write", (command) => {
		const v = verdict("bash", { command });
		expect(v.outcome).toBe("prompt");
		expect(v.gate).toBe("write-protected-path");
	});

	it("leaves ordinary copies alone", () => {
		for (const command of ["cp a.txt b.txt", "mv src/a.ts src/b.ts", "ln -s ../x y", "cp .git/HEAD /tmp/head"]) {
			expect(verdict("bash", { command }).gate).not.toBe("write-protected-path");
		}
	});
});

describe("D: a deny message shows the rule as the user reads it", () => {
	it("does not show the \\* an exact rule stores", () => {
		const v = verdict("bash", { command: "rm *.log" }, cfg({ rules: { deny: ["Bash(rm **)"] } }));
		expect(v.outcome).toBe("block");
		expect(v.reason).toContain("rm *.log");
	});

	it("does not show it in a prompt either", () => {
		const v = verdict("bash", { command: "npm run *" }, cfg({ mode: "ask" }));
		expect(v.outcome).toBe("prompt");
		expect(v.reason).toContain("npm run *");
		// The rule "Always allow" would persist stays escaped.
		expect(v.exact).toBe("Bash(npm run \\*)");
	});
});
