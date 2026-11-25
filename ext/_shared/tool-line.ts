import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../daemon/ansi.ts";

type PiRenderers = ToolRenderers & Required<Pick<ToolRenderers, "renderCall" | "renderResult">>;
type ToolResult = Parameters<PiRenderers["renderResult"]>[0];
type ToolRenderContext = Parameters<PiRenderers["renderCall"]>[2];

const DOT = process.platform === "darwin" ? "⏺" : "●";

export interface CompactLook {
	title: string;
	arg(args: Record<string, unknown>, cwd: string): string;
	summary?(result: ToolResult, theme: Theme, args: Record<string, unknown>): string | string[];
	tally?(result: ToolResult, theme: Theme, args: Record<string, unknown>): string;
}

class Summary implements Component {
	lines: string[] = [];
	render(width: number): string[] {
		return this.lines.map((line) => truncateToWidth(line, width));
	}
	invalidate() {}
}

function summaryLines(summary: string | string[], theme: Theme): string[] {
	const [first, ...rest] = typeof summary === "string" ? [summary] : summary;
	return first === undefined ? [] : [`  ${theme.fg("dim", "⎿")}  ${first}`, ...rest.map((line) => `     ${line}`)];
}

export type TextResult = { content: { type: string; text?: string }[] };

export function outputOf(result: TextResult): string {
	const text = result.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
	return stripAnsi(text).replace(/\r/g, "").trim();
}

function callLine(look: CompactLook, args: unknown, theme: Theme, context: ToolRenderContext): string {
	const dot = context.isPartial ? "dim" : context.isError ? "error" : "accent";
	const arg = look.arg((args ?? {}) as Record<string, unknown>, context.cwd);
	return `${theme.fg(dot, DOT)} ${theme.fg("toolTitle", theme.bold(look.title))}(${arg})`;
}

const argsOf = (context: ToolRenderContext) => (context.args ?? {}) as Record<string, unknown>;

const isBlank = (line: string) => stripAnsi(line).trim() === "";

class WithPiBody implements Component {
	readonly head = new Text("", 0, 0);
	tally = "";
	piCall: Component | undefined;
	readonly piTitle: string;
	constructor(piCall: Component | undefined, piTitle: string) {
		this.piCall = piCall;
		this.piTitle = piTitle;
	}
	render(width: number): string[] {
		const body = this.piCall?.render(width) ?? [];
		// pi's header is the first block of non-blank lines; its padding and spacing are blank.
		let start = 0;
		while (start < body.length && isBlank(body[start])) start++;
		// A tool that pads itself (edit) indents its header; the swapped line keeps that indent.
		const indent = start < body.length ? (/^ */.exec(stripAnsi(body[start]))?.[0].length ?? 0) : 0;
		if (start < body.length && !this.headerNamesPiTitle(body[start])) return body;
		while (start < body.length && !isBlank(body[start])) start++;
		let end = body.length;
		while (end > start && isBlank(body[end - 1])) end--;
		const head = this.head.render(Math.max(1, width - indent)).map((line) => " ".repeat(indent) + line);
		return [...head, ...body.slice(start, end)];
	}
	private headerNamesPiTitle(line: string): boolean {
		return new RegExp(`\\b${this.piTitle}\\b`).test(stripAnsi(line));
	}
	invalidate() {
		this.head.invalidate();
		this.piCall?.invalidate();
	}
}

/** Where a row's call line waits in pi's renderer state, which pi shares between the call and the result. */
const CALL_LINE = Symbol("bluclawd call line");

const hiddenFromPiRenderers = new WeakSet<Component>();

function own<T extends Component>(
	last: Component | undefined,
	kind: abstract new (...args: never[]) => T,
	make: () => T,
): T {
	const component = last instanceof kind && hiddenFromPiRenderers.has(last) ? last : make();
	hiddenFromPiRenderers.add(component);
	return component;
}

function forPi(context: ToolRenderContext): ToolRenderContext {
	const last = context.lastComponent;
	if (!last || !hiddenFromPiRenderers.has(last)) return context;
	return { ...context, lastComponent: last instanceof WithPiBody ? last.piCall : undefined };
}

export function compactTool(pi: PiRenderers, look: CompactLook): ToolRenderers {
	return {
		renderShell: pi.renderShell,
		renderCall(args, theme, context) {
			if (context.expanded) return pi.renderCall(args, theme, forPi(context));
			const line = callLine(look, args, theme, context);
			if (!look.summary) {
				const last = context.lastComponent;
				const call = own(
					last,
					WithPiBody,
					() =>
						new WithPiBody(last && !hiddenFromPiRenderers.has(last) ? last : undefined, look.title.toLowerCase()),
				);
				call.piCall = pi.renderCall(args, theme, { ...context, lastComponent: call.piCall });
				call.head.setText(line + call.tally);
				context.state[CALL_LINE] = call;
				return call;
			}
			// pi's call still runs, unseen, so the state it keeps (bash's start time) is right when the row expands.
			pi.renderCall(args, theme, forPi(context));
			const call = own(context.lastComponent, Text, () => new Text("", 0, 0));
			call.setText(line);
			return call;
		},
		renderResult(result, options, theme, context) {
			if (context.isError)
				return pi.renderResult(result, { ...options, expanded: true }, theme, {
					...forPi(context),
					expanded: true,
				});
			const call: WithPiBody | undefined = context.state[CALL_LINE];
			// pi draws the call before the result, so the tally reaches a call line already drawn.
			if (look.tally && call && !options.expanded && !context.isPartial) {
				call.tally = look.tally(result, theme, argsOf(context));
				call.head.setText(callLine(look, context.args, theme, context) + call.tally);
			}
			if (options.expanded || !look.summary) return pi.renderResult(result, options, theme, forPi(context));
			// Likewise pi's result, which also stops what it started while expanded (bash's redraw every second).
			pi.renderResult(result, options, theme, forPi(context));
			const component = own(context.lastComponent, Summary, () => new Summary());
			component.lines = summaryLines(look.summary(result, theme, argsOf(context)), theme);
			return component;
		},
	};
}

export type OwnLook = CompactLook & Required<Pick<CompactLook, "summary">>;

export function ownTool(look: OwnLook): ToolRenderers {
	return {
		renderCall(args, theme, context) {
			const call = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			call.setText(callLine(look, args, theme, context));
			return call;
		},
		renderResult(result, options, theme, context) {
			if (options.expanded || context.isError) {
				const output = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				const all = outputOf(result).split("\n");
				output.setText(all.map((line) => theme.fg("toolOutput", line)).join("\n"));
				return output;
			}
			const component = context.lastComponent instanceof Summary ? context.lastComponent : new Summary();
			component.lines = summaryLines(look.summary(result, theme, argsOf(context)), theme);
			return component;
		},
	};
}

export function hasPiRenderers(renderers: ToolRenderers | undefined): renderers is PiRenderers {
	return renderers?.renderCall !== undefined && renderers.renderResult !== undefined;
}
