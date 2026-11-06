/**
 * The collapsed look of a tool call in the transcript: `⏺ Name(arg)`, with `⎿ summary` under it.
 *
 * It wraps pi's own renderers (ADR 0007): the expanded view and an error's result
 * are pi's, unchanged.
 */
import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../daemon/ansi.ts";

type PiRenderers = ToolRenderers & Required<Pick<ToolRenderers, "renderCall" | "renderResult">>;
type ToolResult = Parameters<PiRenderers["renderResult"]>[0];
type ToolRenderContext = Parameters<PiRenderers["renderCall"]>[2];

/** `⏺` on macOS, `●` elsewhere, as background-bash draws its lines. */
const DOT = process.platform === "darwin" ? "⏺" : "●";

export interface CompactLook {
	/** The capitalised tool name, as in `Read`. */
	title: string;
	/** What goes between the parentheses. */
	arg(args: Record<string, unknown>, cwd: string): string;
	/**
	 * The lines under `⎿`, while the call streams and once it succeeded. A look
	 * without one keeps pi's body (a diff, a file) under the call line, and pi's result.
	 */
	summary?(result: ToolResult, theme: Theme): string | string[];
}

/** The `⎿` lines, each cut to the width rather than wrapped, so one long line cannot fill the screen. */
class Summary implements Component {
	lines: string[] = [];
	render(width: number): string[] {
		return this.lines.map((line) => truncateToWidth(line, width));
	}
	invalidate() {}
}

const isBlank = (line: string) => stripAnsi(line).trim() === "";

/** pi's call component with its header line swapped for the `⏺ Name(arg)` line. */
class WithPiBody implements Component {
	readonly head = new Text("", 0, 0);
	piCall: Component | undefined;
	constructor(piCall: Component | undefined) {
		this.piCall = piCall;
	}
	render(width: number): string[] {
		const body = this.piCall?.render(width) ?? [];
		// pi's header is the first block of non-blank lines; its padding and spacing are blank.
		let start = 0;
		while (start < body.length && isBlank(body[start])) start++;
		// A tool that pads itself (edit) indents its header; the swapped line keeps that indent.
		const indent = start < body.length ? (/^ */.exec(stripAnsi(body[start]))?.[0].length ?? 0) : 0;
		while (start < body.length && !isBlank(body[start])) start++;
		let end = body.length;
		while (end > start && isBlank(body[end - 1])) end--;
		const head = this.head.render(Math.max(1, width - indent)).map((line) => " ".repeat(indent) + line);
		return [...head, ...body.slice(start, end)];
	}
	invalidate() {
		this.head.invalidate();
		this.piCall?.invalidate();
	}
}

/** The components this file drew, so pi's renderers are never handed one as their `lastComponent`. */
const drawnHere = new WeakSet<Component>();

function own<T extends Component>(
	last: Component | undefined,
	kind: abstract new (...args: never[]) => T,
	make: () => T,
): T {
	const component = last instanceof kind && drawnHere.has(last) ? last : make();
	drawnHere.add(component);
	return component;
}

/** The context pi's renderers see: their own last component, never one drawn here. */
function forPi(context: ToolRenderContext): ToolRenderContext {
	const last = context.lastComponent;
	if (!last || !drawnHere.has(last)) return context;
	return { ...context, lastComponent: last instanceof WithPiBody ? last.piCall : undefined };
}

export function compactTool(pi: PiRenderers, look: CompactLook): ToolRenderers {
	return {
		renderShell: pi.renderShell,
		renderCall(args, theme, context) {
			if (context.expanded) return pi.renderCall(args, theme, forPi(context));
			const dot = context.isPartial ? "dim" : context.isError ? "error" : "accent";
			const arg = look.arg((args ?? {}) as Record<string, unknown>, context.cwd);
			const line = `${theme.fg(dot, DOT)} ${theme.fg("toolTitle", theme.bold(look.title))}(${arg})`;
			if (!look.summary) {
				const last = context.lastComponent;
				const call = own(last, WithPiBody, () => new WithPiBody(last && !drawnHere.has(last) ? last : undefined));
				call.piCall = pi.renderCall(args, theme, { ...context, lastComponent: call.piCall });
				call.head.setText(line);
				return call;
			}
			// pi's call still runs, unseen, so the state it keeps (bash's start time) is right when the row expands.
			pi.renderCall(args, theme, forPi(context));
			const call = own(context.lastComponent, Text, () => new Text("", 0, 0));
			call.setText(line);
			return call;
		},
		renderResult(result, options, theme, context) {
			// An error is never folded: pi's expanded result.
			if (context.isError)
				return pi.renderResult(result, { ...options, expanded: true }, theme, {
					...forPi(context),
					expanded: true,
				});
			if (options.expanded || !look.summary) return pi.renderResult(result, options, theme, forPi(context));
			// Likewise pi's result, which also stops what it started while expanded (bash's redraw every second).
			pi.renderResult(result, options, theme, forPi(context));
			const summary = look.summary(result, theme);
			const [first, ...rest] = typeof summary === "string" ? [summary] : summary;
			const component = own(context.lastComponent, Summary, () => new Summary());
			component.lines =
				first === undefined ? [] : [`  ${theme.fg("dim", "⎿")}  ${first}`, ...rest.map((line) => `     ${line}`)];
			return component;
		},
	};
}

/** pi's renderers for a tool, when it has both a call and a result renderer to fall back to. */
export function hasPiRenderers(renderers: ToolRenderers | undefined): renderers is PiRenderers {
	return renderers?.renderCall !== undefined && renderers.renderResult !== undefined;
}
