/**
 * Shell extension: bash mode — a persistent shell driven from the prompt editor.
 *
 * `ctrl+shift+b` or `/bash-mode [on|off]` switches the editor between the model
 * and a long-lived shell (./session.ts), so `cd`, `export` and functions carry
 * from one command to the next. Output goes to a transcript widget below the
 * editor, NOT into the conversation: bash mode is the user's own terminal, while
 * `!` remains the way to show the model a command's output. A finished command
 * signals a possible working-tree change so the footer's git counts refresh.
 *
 * Like `!`, bash mode runs outside the sandbox (Claude Code parity).
 *
 * Bash mode itself was adapted from pi-powerline-footer (MIT, Nico Bailon).
 */
import type { ExtensionAPI, ExtensionContext, InlineExtension, Theme } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Key, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { workingTreeChanged } from "../_shared/working-tree.ts";
import { ShellEditor } from "./editor.ts";
import { ShellSession } from "./session.ts";
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
				onCommandFinished: () => workingTreeChanged(),
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
	}

	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
		reset();
		ctx.ui.setStatus("shell", undefined);
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
