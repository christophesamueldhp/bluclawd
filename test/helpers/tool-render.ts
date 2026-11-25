import { initTheme, type ToolRendererResolver, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "../../daemon/ansi.ts";
import transcript from "../../ext/transcript/index.ts";

// Some of pi's renderers (the shell, grep, find, ls) draw with its global theme, not the one passed in.
initTheme("dark");

export const DOT = process.platform === "darwin" ? "⏺" : "●";

export const theme = {
	fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
	bg: (_c: string, t: string) => t,
	bold: (t: string) => `<b>${t}</b>`,
	italic: (t: string) => t,
	underline: (t: string) => t,
} as any;
export const plain = (s: string) => stripAnsi(s).replace(/<\/?[a-zA-Z]+>/g, "");

export function resolver(): ToolRendererResolver {
	let registered: ToolRendererResolver | undefined;
	transcript({
		registerToolRenderer: (r: ToolRendererResolver) => {
			registered = r;
		},
	} as any);
	if (!registered) throw new Error("no tool renderer registered");
	return registered;
}

export const restyled = (toolName: string, base: unknown): ToolRenderers =>
	resolver()(toolName, () => base as never) as ToolRenderers;

export interface Row {
	args: Record<string, unknown>;
	result?: { content: { type: "text"; text: string }[]; details?: unknown };
	expanded?: boolean;
	isPartial?: boolean;
	isError?: boolean;
	argsComplete?: boolean;
}

export function contextFor(row: Row, cwd = "/work") {
	return {
		args: row.args,
		toolCallId: "call-1",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd,
		executionStarted: true,
		argsComplete: row.argsComplete ?? true,
		isPartial: row.isPartial ?? false,
		expanded: row.expanded ?? false,
		showImages: false,
		isError: row.isError ?? false,
		outputPad: 1,
	} as any;
}

export function draw(renderers: ToolRenderers, row: Row, width = 120): string {
	const context = contextFor(row);
	const call = renderers.renderCall?.(row.args, theme, context);
	const options = { expanded: context.expanded, isPartial: context.isPartial };
	const result = row.result && renderers.renderResult?.(row.result as never, options, theme, context);
	return [...(call?.render(width) ?? []), ...(result?.render(width) ?? [])].map((line) => line.trimEnd()).join("\n");
}

export const text = (t: string, details?: unknown) => ({
	content: [{ type: "text" as const, text: t }],
	...(details === undefined ? {} : { details }),
});
