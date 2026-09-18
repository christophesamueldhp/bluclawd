/**
 * MCP elicitation (form mode): a server asks the user for a few values mid-call.
 * Each field of the flat `requestedSchema` becomes one pi dialog. Dismissing any
 * dialog cancels the whole request; a URL-mode request is declined.
 */

interface FieldSchema {
	type?: string;
	title?: string;
	description?: string;
	enum?: unknown[];
	oneOf?: { const?: unknown; title?: string }[];
	items?: { enum?: unknown[]; anyOf?: { const?: unknown; title?: string }[] };
	default?: unknown;
}

export interface ElicitParams {
	mode?: string;
	message?: string;
	requestedSchema?: { properties?: Record<string, FieldSchema>; required?: string[] };
}

export type ElicitAnswer =
	| { action: "accept"; content: Record<string, string | number | boolean | string[]> }
	| { action: "decline" | "cancel" };

export interface ElicitUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
}

/** An enum field's choices as {value, label}: plain `enum`, or titled `oneOf`/`anyOf`. */
function choices(values: unknown[] | undefined, titled: { const?: unknown; title?: string }[] | undefined) {
	if (titled) return titled.map((o) => ({ value: String(o.const), label: o.title ?? String(o.const) }));
	return (values ?? []).map((v) => ({ value: String(v), label: String(v) }));
}

export async function answerElicitation(server: string, params: ElicitParams, ui: ElicitUI): Promise<ElicitAnswer> {
	if (params.mode !== undefined && params.mode !== "form") return { action: "decline" };
	const fields = Object.entries(params.requestedSchema?.properties ?? {});
	const required = new Set(params.requestedSchema?.required ?? []);
	const heading = `MCP ${server}: ${params.message ?? "input requested"}`;

	if (fields.length === 0) {
		return (await ui.confirm(heading, "Continue?")) ? { action: "accept", content: {} } : { action: "decline" };
	}

	const content: Record<string, string | number | boolean | string[]> = {};
	for (const [key, field] of fields) {
		const label = field.title ?? key;
		const title = `${heading}\n${label}${field.description ? ` — ${field.description}` : ""}${required.has(key) ? "" : " (optional)"}`;

		if (field.type === "boolean") {
			content[key] = await ui.confirm(title, label);
			continue;
		}

		if (field.type === "array") {
			const options = choices(field.items?.enum, field.items?.anyOf);
			const raw = await ui.input(
				`${title}\nChoose any of: ${options.map((o) => o.label).join(", ")}`,
				"comma-separated",
			);
			if (raw === undefined) return { action: "cancel" };
			const picked = raw
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
				.map((s) => options.find((o) => o.label === s || o.value === s)?.value)
				.filter((v): v is string => v !== undefined);
			if (picked.length > 0 || required.has(key)) content[key] = picked;
			continue;
		}

		const options = choices(field.enum, field.oneOf);
		if (options.length > 0) {
			const skip = "(skip)";
			const picked = await ui.select(title, [...options.map((o) => o.label), ...(required.has(key) ? [] : [skip])]);
			if (picked === undefined) return { action: "cancel" };
			const value = options.find((o) => o.label === picked)?.value;
			if (value !== undefined) content[key] = value;
			continue;
		}

		const numeric = field.type === "number" || field.type === "integer";
		for (;;) {
			const placeholder = field.default !== undefined ? String(field.default) : numeric ? "a number" : undefined;
			const raw = await ui.input(title, placeholder);
			if (raw === undefined) return { action: "cancel" };
			const text = raw.trim();
			if (text === "") {
				if (!required.has(key)) break;
				continue;
			}
			if (!numeric) {
				content[key] = text;
				break;
			}
			const n = Number(text);
			if (Number.isFinite(n) && (field.type === "number" || Number.isInteger(n))) {
				content[key] = n;
				break;
			}
		}
	}
	return { action: "accept", content };
}
