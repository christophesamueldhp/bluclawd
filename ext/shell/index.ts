/**
 * Shell extension: bash mode — a persistent shell driven from the prompt editor.
 *
 * `ctrl+shift+b` or `/bash-mode [on|off]` switches the editor between the model
 * and a long-lived shell (./session.ts), so `cd`, `export` and functions carry
 * from one command to the next. Output goes to a transcript widget below the
 * editor, NOT into the conversation: bash mode is the user's own terminal, while
 * `!` remains the way to show the model a command's output.
 *
 * Like `!`, bash mode runs outside the sandbox (Claude Code parity).
 *
 * The editor stash lives here too (`alt+s`, `/stash`; ./stash.ts): it acts on
 * the same editor and has no other owner.
 *
 * Bash mode and the stash were adapted from pi-powerline-footer (MIT, Nico Bailon).
 */
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, InlineExtension, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Key, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { ShellEditor } from "./editor.ts";
import { ShellSession } from "./session.ts";
import { StashHistory, stashAction } from "./stash.ts";
import { ShellTranscript } from "./transcript.ts";

/** Commands and output lines per command the widget shows; the rest stays in the transcript. */
const WIDGET_COMMANDS = 4;
const WIDGET_OUTPUT_LINES = 6;

type ThemeLike = Pick<Theme, "fg">;

/** The widget below the editor while bash mode is on. */
export function renderTranscriptLines(
	transcript: ShellTranscript,
	width: number,
	theme: ThemeLike,
	state: { shellName: string; cwd: string; running: boolean },
): string[] {
	const lines = [
		` ${theme.fg("accent", "bash mode")} ${theme.fg("dim", `· ${state.shellName} · ${state.cwd} · Escape leaves, Ctrl+C interrupts`)}`,
	];
	if (transcript.dropped > 0) {
		lines.push(
			` ${theme.fg("dim", `… ${transcript.dropped} earlier command${transcript.dropped === 1 ? "" : "s"} not shown`)}`,
		);
	}
	for (const record of transcript.commands.slice(-WIDGET_COMMANDS)) {
		const status =
			record.exitCode === null
				? theme.fg("accent", "running")
				: record.exitCode === 0
					? theme.fg("success", "ok")
					: theme.fg("error", `exit ${record.exitCode}`);
		const command = record.command.replace(/\s+/g, " ").trim();
		lines.push(` ${theme.fg("accent", "$")} ${command} ${theme.fg("dim", "(")}${status}${theme.fg("dim", ")")}`);
		for (const output of record.output.slice(-WIDGET_OUTPUT_LINES)) lines.push(`   ${output}`);
	}
	return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
}

export function factory(pi: ExtensionAPI): void {
	let active = false;
	let session: ShellSession | undefined;
	let transcript = new ShellTranscript();
	let tui: TUI | undefined;
	let latestCtx: ExtensionContext | undefined;

	const repaint = () => tui?.requestRender();

	function publishStatus(ctx: ExtensionContext): void {
		if (!active || !session) {
			ctx.ui.setStatus("shell", undefined);
			return;
		}
		const state = session.state.running ? "running" : "idle";
		ctx.ui.setStatus("shell", ctx.ui.theme.fg("accent", `bash mode · ${session.state.shellName} · ${state}`));
	}

	function ensureSession(ctx: ExtensionContext): ShellSession {
		if (!session) {
			const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
			session = new ShellSession({
				shellPath: settings.getShellPath() ?? process.env.SHELL ?? "/bin/sh",
				cwd: ctx.cwd,
				transcript,
				onChange: () => {
					if (latestCtx) publishStatus(latestCtx);
					repaint();
				},
			});
		}
		return session;
	}

	async function setActive(value: boolean, ctx: ExtensionContext): Promise<void> {
		if (value === active) return;
		if (!value) {
			if (session?.state.running) {
				ctx.ui.notify(
					"A shell command is still running — Ctrl+C interrupts it before leaving bash mode.",
					"warning",
				);
				return;
			}
			active = false;
			publishStatus(ctx);
			repaint();
			return;
		}
		try {
			await ensureSession(ctx).start();
			active = true;
		} catch (error) {
			session?.dispose();
			session = undefined;
			ctx.ui.notify(`Could not start the shell: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
		publishStatus(ctx);
		repaint();
	}

	function reset(): void {
		session?.dispose();
		session = undefined;
		transcript = new ShellTranscript();
		active = false;
		stashed = undefined;
	}

	/** The active stash of this session; the history outlives it. */
	let stashed: string | undefined;
	let stashHistory: StashHistory | undefined;
	const history = () => {
		stashHistory ??= new StashHistory(join(getAgentDir(), "bluclawd", "stash-history.json"));
		return stashHistory;
	};

	function toggleStash(ctx: ExtensionContext): void {
		const text = ctx.ui.getEditorText();
		switch (stashAction(text, stashed)) {
			case "nothing":
				ctx.ui.notify("Nothing to stash — the editor is empty.", "info");
				return;
			case "restore":
				ctx.ui.setEditorText(stashed ?? "");
				stashed = undefined;
				ctx.ui.setStatus("stash", undefined);
				ctx.ui.notify("Stash restored.", "info");
				return;
			case "stash":
			case "update": {
				const updated = stashed !== undefined;
				stashed = text;
				history().add(text);
				ctx.ui.setEditorText("");
				ctx.ui.setStatus("stash", ctx.ui.theme.fg("accent", "stash"));
				ctx.ui.notify(
					updated
						? "Stash updated — Alt+S on an empty editor brings it back."
						: "Stashed — Alt+S on an empty editor brings it back.",
					"info",
				);
			}
		}
	}

	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
		reset();
		ctx.ui.setStatus("shell", undefined);
		ctx.ui.setStatus("stash", undefined);
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		ctx.ui.setEditorComponent((editorTui, theme, keybindings) => {
			tui = editorTui;
			return new ShellEditor(editorTui, theme, keybindings, {
				bashMode: () => active,
				running: () => session?.state.running ?? false,
				exitBashMode: () => void setActive(false, ctx),
				interrupt: () => session?.interrupt(),
				submit: (command) => {
					if (!session) return;
					session.run(command).catch((error: unknown) => {
						ctx.ui.notify(
							`Shell command failed to start: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
					});
				},
				history: () => transcript.commands.map((record) => record.command),
				notify: (message) => ctx.ui.notify(message, "warning"),
			});
		});
		ctx.ui.setWidget(
			"shell-transcript",
			(_tui, theme) => ({
				invalidate() {},
				render: (width: number) =>
					active && session ? renderTranscriptLines(transcript, width, theme, session.state) : [],
			}),
			{ placement: "belowEditor" },
		);
	});

	pi.on("session_shutdown", () => {
		reset();
	});

	pi.registerShortcut(Key.ctrlShift("b"), {
		description: "Toggle bash mode (a persistent shell in the prompt)",
		handler: async (ctx) => setActive(!active, ctx),
	});

	pi.registerShortcut(Key.alt("s"), {
		description: "Stash the prompt, or bring the stash back into an empty editor",
		handler: (ctx) => toggleStash(ctx),
	});

	pi.registerCommand("stash", {
		description: "Insert a previously stashed prompt into the editor",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("The stash needs the interactive terminal.", "warning");
				return;
			}
			const entries = history().entries;
			if (entries.length === 0) {
				ctx.ui.notify("Nothing stashed yet — Alt+S stashes the prompt you are writing.", "info");
				return;
			}
			const labels = entries.map((entry, index) => `${index + 1}. ${entry.replace(/\s+/g, " ").trim()}`);
			const choice = await ctx.ui.select("Stashed prompts", labels);
			if (choice === undefined) return;
			const picked = entries[labels.indexOf(choice)];
			if (picked === undefined) return;
			ctx.ui.setEditorText(picked);
			// setEditorText does not repaint; without this the text is there but invisible until the next keypress.
			repaint();
		},
	});

	pi.registerCommand("bash-mode", {
		description: "Bash mode: a persistent shell in the prompt (on, off, or toggle)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Bash mode needs the interactive terminal.", "warning");
				return;
			}
			const arg = args.trim().toLowerCase();
			if (arg && arg !== "on" && arg !== "off" && arg !== "toggle") {
				ctx.ui.notify("Usage: /bash-mode [on|off|toggle]", "warning");
				return;
			}
			await setActive(arg === "on" ? true : arg === "off" ? false : !active, ctx);
		},
	});
}

const shellExtension: InlineExtension = { name: "shell", factory };
export default shellExtension.factory;
