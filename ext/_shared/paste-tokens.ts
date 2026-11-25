const COLLAPSE_CHARS = 800;
const COLLAPSE_LINES = 2;

const TOKEN = /\[(?:Pasted text #(\d+)(?: \+\d+ lines)?|Image #(\d+))\]/g;

export function shouldCollapse(text: string): boolean {
	return text.length > COLLAPSE_CHARS || text.split("\n").length > COLLAPSE_LINES;
}

type Kind = "text" | "image";

interface Entry {
	kind: Kind;
	content: string;
	token: string;
}

export class PasteTokens {
	private readonly entries = new Map<number, Entry>();
	private next = 1;
	private last: Entry | undefined;

	addText(text: string): string {
		const extra = text.split("\n").length - 1;
		return this.add("text", text, (id) => (extra ? `[Pasted text #${id} +${extra} lines]` : `[Pasted text #${id}]`));
	}

	addImage(path: string): string {
		return this.add("image", path, (id) => `[Image #${id}]`);
	}

	private add(kind: Kind, content: string, token: (id: number) => string): string {
		const id = this.next++;
		const entry = { kind, content, token: token(id) };
		this.entries.set(id, entry);
		this.last = entry;
		return entry.token;
	}

	repeatOf(
		kind: Kind,
		content: string,
		same: (held: string, pasted: string) => boolean = (a, b) => a === b,
	): { token: string; content: string } | undefined {
		const last = this.last;
		if (!last || last.kind !== kind || !same(last.content, content)) return undefined;
		return { token: last.token, content: last.content };
	}

	forgetRepeatTarget(): void {
		this.last = undefined;
	}

	expandText(text: string): string {
		return text.replace(TOKEN, (match, textId?: string) => {
			const entry = textId ? this.entries.get(Number(textId)) : undefined;
			return entry?.kind === "text" && entry.token === match ? entry.content : match;
		});
	}

	imagesIn(text: string): string[] {
		const paths: string[] = [];
		for (const match of text.matchAll(TOKEN)) {
			const entry = match[2] ? this.entries.get(Number(match[2])) : undefined;
			if (entry?.kind === "image" && entry.token === match[0]) paths.push(entry.content);
		}
		return paths;
	}

	ranges(text: string): Array<{ start: number; end: number }> {
		const out: Array<{ start: number; end: number }> = [];
		for (const match of text.matchAll(TOKEN)) {
			const entry = this.entries.get(Number(match[1] ?? match[2]));
			if (entry?.token === match[0]) out.push({ start: match.index, end: match.index + match[0].length });
		}
		return out;
	}

	clear(): void {
		this.entries.clear();
		this.next = 1;
		this.last = undefined;
	}
}
