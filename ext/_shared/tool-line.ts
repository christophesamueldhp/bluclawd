/**
 * The collapsed look of a tool call in the transcript: `⏺ Name(arg)`, with `⎿ summary` under it.
 *
 * It wraps pi's own renderers (ADR 0007): the expanded view and an error's result
 * are pi's, unchanged.
 */
import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";

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
	/** The line under `⎿` once the call succeeded. */
	summary(result: ToolResult): string;
}

/** The components this file drew, so pi's renderers are never handed one as their `lastComponent`. */
const drawnHere = new WeakSet<Component>();

function ownText(last: Component | undefined, text: string): Text {
	const component = last && drawnHere.has(last) ? (last as Text) : new Text("", 0, 0);
	drawnHere.add(component);
	component.setText(text);
	return component;
}

function withoutOwnComponent(context: ToolRenderContext): ToolRenderContext {
	return context.lastComponent && drawnHere.has(context.lastComponent)
		? { ...context, lastComponent: undefined }
		: context;
}

export function compactTool(pi: PiRenderers, look: CompactLook): ToolRenderers {
	return {
		renderShell: pi.renderShell,
		renderCall(args, theme, context) {
			if (context.expanded) return pi.renderCall(args, theme, withoutOwnComponent(context));
			const dot = context.isPartial ? "dim" : context.isError ? "error" : "accent";
			const arg = look.arg((args ?? {}) as Record<string, unknown>, context.cwd);
			return ownText(
				context.lastComponent,
				`${theme.fg(dot, DOT)} ${theme.fg("toolTitle", theme.bold(look.title))}(${arg})`,
			);
		},
		renderResult(result, options, theme, context) {
			if (options.expanded || context.isError)
				return pi.renderResult(result, options, theme, withoutOwnComponent(context));
			return ownText(context.lastComponent, `  ${theme.fg("dim", "⎿")}  ${look.summary(result)}`);
		},
	};
}

/** pi's renderers for a tool, when it has both a call and a result renderer to fall back to. */
export function hasPiRenderers(renderers: ToolRenderers | undefined): renderers is PiRenderers {
	return renderers?.renderCall !== undefined && renderers.renderResult !== undefined;
}
