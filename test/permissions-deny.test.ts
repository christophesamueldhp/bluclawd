/**
 * Deny rules and the project-trust badge: the whole of the permissions extension.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { denyRules } from "../ext/_shared/settings.ts";
import permissions, { trustStatusText } from "../ext/permissions/index.ts";
import { deniedBy } from "../ext/permissions/rules.ts";

const cwd = "/proj";
const denied = (rules: string[], tool: string, input: Record<string, unknown>) =>
	deniedBy(rules, tool, input, cwd) !== undefined;

describe("denyRules: global and project lists", () => {
	const sm = (global: unknown, project: unknown) =>
		({
			getGlobalSettings: () => ({ permissions: global }),
			getProjectSettings: () => (project === undefined ? {} : { permissions: project }),
		}) as unknown as SettingsManager;

	it("combines both scopes, deduped", () => {
		expect(denyRules(sm({ deny: ["Bash(rm *)"] }, { deny: ["Bash(rm *)", "WebFetch"] }))).toEqual([
			"Bash(rm *)",
			"WebFetch",
		]);
	});

	it("an empty project list cannot drop the user's global rules", () => {
		expect(denyRules(sm({ deny: ["Read(~/.ssh/**)"] }, { deny: [] }))).toEqual(["Read(~/.ssh/**)"]);
	});

	it("reads nothing but deny", () => {
		expect(denyRules(sm({ allow: ["Bash(**)"], ask: ["Bash(**)"] }, undefined))).toEqual([]);
	});
});

describe("deniedBy", () => {
	it("matches bash through its respellings", () => {
		const rules = ["Bash(rm *)"];
		for (const command of ["rm", "rm -rf build", "ls && rm x", "env X=1 rm x", "nohup rm x", "/bin/rm x", "\\rm x"]) {
			expect(denied(rules, "bash", { command })).toBe(true);
		}
		expect(denied(rules, "bash", { command: "sh -c 'rm -rf x'" })).toBe(true);
		expect(denied(rules, "bash", { command: "rmdir x" })).toBe(false);
	});

	it("an Edit rule covers write, a Read rule covers grep/find/ls", () => {
		expect(denied(["Edit(./x)"], "write", { path: "./x" })).toBe(true);
		expect(denied(["Read(.env)"], "grep", { pattern: "k", path: ".env" })).toBe(true);
		expect(denied(["Read(/proj/**)"], "ls", { path: "sub" })).toBe(true);
		// grep with no path searches the working directory, so a rule on it still applies.
		expect(denied(["Read(/proj)"], "grep", { pattern: "k" })).toBe(true);
		expect(denied(["Write(./x)"], "edit", { path: "./x" })).toBe(false);
	});

	it("matches paths resolved against the working directory, and //abs", () => {
		expect(denied(["Read(/proj/secrets/**)"], "read", { path: "secrets/a" })).toBe(true);
		expect(denied(["Read(//etc/**)"], "read", { path: "/etc/hosts" })).toBe(true);
	});

	it("a relative path rule matches every spelling of the path it names", () => {
		for (const path of [".env", "./.env", "/proj/.env", "sub/../.env"]) {
			expect(denied(["Read(.env)"], "read", { path }), path).toBe(true);
		}
		expect(denied(["Read(.env)"], "bash", { command: "cat ./.env" })).toBe(true);
		expect(denied(["Edit(src/**)"], "write", { path: "/proj/src/a.ts" })).toBe(true);
		expect(denied(["Read(.env)"], "read", { path: "/proj/sub/.env" })).toBe(false);
	});

	it("names MCP tools either way, and fetches by domain", () => {
		expect(denied(["mcp__github__*"], "mcp__github__get_me", {})).toBe(true);
		expect(denied(["Mcp(github:get_me)"], "mcp__github__get_me", {})).toBe(true);
		expect(denied(["mcp__github"], "mcp__gitlab__get_me", {})).toBe(false);
		expect(denied(["WebFetch(domain:*.evil.com)"], "webfetch", { url: "https://a.evil.com/x" })).toBe(true);
	});

	it("leaves a longer command name alone, and ungoverned tools", () => {
		expect(denied(["Bash(ls *)"], "bash", { command: "lsof" })).toBe(false);
		expect(denied(["Bash(**)"], "task_stop", {})).toBe(false);
	});

	it("sees through exec wrappers and shell keywords, flag values included", () => {
		const rules = ["Bash(rm *)"];
		for (const command of [
			"timeout 5 rm x",
			"timeout -s KILL 5 rm x",
			"sudo -u root rm x",
			"doas rm x",
			"nice -n 10 rm x",
			"time rm x",
			"command rm x",
			"builtin exec rm x",
			"stdbuf -oL rm x",
			"strace -f -o out rm x",
			"watch -n 5 rm x",
			"env -u HOME rm x",
			"eval 'rm x'",
			"sudo timeout 5 nice rm x",
			"if rm x; then echo; fi",
			"for f in a; do rm $f; done",
			"! rm x",
		]) {
			expect(denied(rules, "bash", { command }), command).toBe(true);
		}
	});

	it("sees through quoting and command substitution", () => {
		const rules = ["Bash(rm *)"];
		for (const command of [
			"'rm' x",
			'"rm" x',
			'r""m x',
			"$'rm' x",
			"r\\m x",
			"echo $(rm x)",
			"echo `rm x`",
			"(rm x)",
		]) {
			expect(denied(rules, "bash", { command }), command).toBe(true);
		}
		expect(denied(["Bash(rm -rf *)"], "bash", { command: "rm '-rf' x" })).toBe(true);
		expect(denied(rules, "bash", { command: "echo 'rmdir'" })).toBe(false);
	});

	it("a Read or Edit rule guards the paths a bash command names", () => {
		const home = process.env.HOME ?? "";
		const ssh = ["Read(~/.ssh/**)"];
		for (const command of [
			"cat ~/.ssh/id_rsa",
			'cat "$HOME/.ssh/id_rsa"',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell variable, not a template
			"cat ${HOME}/.ssh/id_rsa",
			`base64 < ${home}/.ssh/id_rsa`,
			"ls ~/.ssh",
			"cp ~/.ssh/id_rsa /tmp/k",
			"tar czf out.tgz ~/.ssh",
		]) {
			expect(denied(ssh, "bash", { command }), command).toBe(true);
		}
		expect(denied(["Edit(/proj/.git/**)"], "bash", { command: "echo x > .git/config" })).toBe(true);
		expect(denied(["Edit(//etc/**)"], "bash", { command: "dd if=x of=/etc/hosts" })).toBe(true);
		expect(denied(ssh, "bash", { command: "cat ~/.sshx/key" })).toBe(false);
		// A plain word that is not a path on disk is not a path.
		expect(denied(["Read(/proj/**)"], "bash", { command: "npm test" })).toBe(false);
	});

	it("expands a command's globs the way the shell will", () => {
		const dir = mkdtempSync(join(tmpdir(), "deny-glob-"));
		try {
			mkdirSync(join(dir, ".ssh"));
			writeFileSync(join(dir, ".ssh", "id_rsa"), "");
			writeFileSync(join(dir, "secrets.txt"), "");
			const ssh = [`Read(${dir}/.ssh/**)`];
			for (const command of [`cat ${dir}/.ss*/id_rsa`, "cat .s?h/id_rsa", "cat .[s]sh/id_rsa", "cat .ssh/id_*"]) {
				expect(deniedBy(ssh, "bash", { command }, dir), command).toBeDefined();
			}
			// Like the shell, `*` does not match a leading dot.
			expect(deniedBy(ssh, "bash", { command: "cat */id_rsa" }, dir)).toBeUndefined();
			expect(deniedBy(["Read(secrets.txt)"], "bash", { command: "cat secret*" }, dir)).toBeDefined();
			expect(deniedBy(["Read(secrets.txt)"], "bash", { command: "cat other*" }, dir)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("denies a glob too broad to check rather than half-checking it", () => {
		const dir = mkdtempSync(join(tmpdir(), "deny-glob-wide-"));
		try {
			mkdirSync(join(dir, "many"));
			for (let i = 0; i <= 10_000; i++) writeFileSync(join(dir, "many", `f${i}`), "");
			expect(deniedBy(["Read(/nowhere/**)"], "bash", { command: "cat many/*/x" }, dir)).toBeDefined();
			expect(deniedBy(["Read(/nowhere/**)"], "bash", { command: "cat many/f1" }, dir)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("follows cd, and a bare file name that exists", () => {
		const dir = mkdtempSync(join(tmpdir(), "deny-cd-"));
		try {
			mkdirSync(join(dir, "secret"));
			writeFileSync(join(dir, "secret", "key"), "");
			const rules = [`Read(${join(dir, "secret")}/**)`];
			expect(deniedBy(rules, "bash", { command: "cd secret && cat key" }, dir)).toBeDefined();
			expect(deniedBy(rules, "bash", { command: "cat secret" }, dir)).toBeDefined();
			expect(deniedBy(rules, "bash", { command: "cat other" }, dir)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a dir/** rule covers the directory itself, not a sibling prefix", () => {
		expect(denied(["Read(~/.ssh/**)"], "ls", { path: "~/.ssh" })).toBe(true);
		expect(denied(["Read(//**)"], "read", { path: "/etc/hosts" })).toBe(true);
		expect(denied(["Read(/proj/sec/**)"], "read", { path: "secrets" })).toBe(false);
	});
});

describe("the extension", () => {
	let home: string;
	let dir: string;
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "bluclawd-deny-home-"));
		dir = mkdtempSync(join(tmpdir(), "bluclawd-deny-cwd-"));
		saved.HOME = process.env.HOME;
		for (const key of Object.keys(process.env)) {
			if (key.endsWith("_CODING_AGENT_DIR")) {
				saved[key] = process.env[key];
				delete process.env[key];
			}
		}
		process.env.HOME = home;
		mkdirSync(getAgentDir(), { recursive: true });
	});
	afterEach(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(home, { recursive: true, force: true });
		rmSync(dir, { recursive: true, force: true });
	});

	const globalSettings = () => join(getAgentDir(), "settings.json");

	function load(settings: Record<string, unknown>) {
		writeFileSync(globalSettings(), JSON.stringify(settings));
		const handlers: Record<string, (event: any, ctx: any) => Promise<any>> = {};
		let shortcut: ((ctx: any) => Promise<void>) | undefined;
		const status: Record<string, string | undefined> = {};
		const notes: string[] = [];
		permissions({
			on: (event: string, handler: any) => {
				handlers[event] = handler;
			},
			registerShortcut: (_key: unknown, def: any) => {
				shortcut = def.handler;
			},
		} as any);
		const ctx = {
			cwd: dir,
			isProjectTrusted: () => true,
			ui: {
				setStatus: (key: string, text: string | undefined) => {
					status[key] = text;
				},
				notify: (text: string) => notes.push(text),
				theme: { fg: (_c: string, t: string) => t, getColorMode: () => "256" },
			},
		};
		const call = (toolName: string, input: Record<string, unknown>) => handlers.tool_call({ toolName, input }, ctx);
		return { handlers, ctx, call, status, notes, press: () => shortcut?.(ctx) };
	}

	it("blocks a denied call with the rule, and runs everything else", async () => {
		const { handlers, ctx, call } = load({ permissions: { deny: ["Bash(rm *)"] } });
		await handlers.session_start({}, ctx);
		expect(await call("bash", { command: "rm -rf x" })).toEqual({
			block: true,
			reason: "Blocked by permission rule (deny): Bash(rm *)",
		});
		expect(await call("bash", { command: "npm test" })).toBeUndefined();
		expect(await call("write", { path: ".git/hooks/pre-commit" })).toBeUndefined();
	});

	it("judges a monitor as bash, and a websearch batch query by query", async () => {
		const { handlers, ctx, call } = load({ permissions: { deny: ["Bash(rm *)", "WebSearch(*secret*)"] } });
		await handlers.session_start({}, ctx);
		expect((await call("monitor", { command: "rm x", description: "d" }))?.block).toBe(true);
		expect((await call("websearch", { queries: ["vitest", "the secret plan"] }))?.block).toBe(true);
		expect(await call("websearch", { queries: ["vitest"] })).toBeUndefined();
	});

	it("shows defaultProjectTrust and cycles it with Alt+M, saved to global settings", async () => {
		const { handlers, ctx, status, press, notes } = load({ defaultProjectTrust: "always" });
		await handlers.session_start({}, ctx);
		expect(status["1-mode"]).toBe("⏵⏵ always (alt+m to cycle)");
		await press();
		expect(JSON.parse(readFileSync(globalSettings(), "utf8")).defaultProjectTrust).toBe("ask");
		expect(status["1-mode"]).toBe("⏸ ask (alt+m to cycle)");
		expect(notes.at(-1)).toContain("ask");
		await press();
		expect(status["1-mode"]).toBe("✕ never (alt+m to cycle)");
		await press();
		expect(JSON.parse(readFileSync(globalSettings(), "utf8")).defaultProjectTrust).toBe("always");
	});

	it("paints always amber in truecolor", () => {
		const ctx = { ui: { theme: { fg: (_c: string, t: string) => t, getColorMode: () => "truecolor" } } } as any;
		expect(trustStatusText(ctx, "always")).toContain("\x1b[38;2;255;193;7m⏵⏵ always");
	});
});
