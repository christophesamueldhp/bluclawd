/**
 * A Project's Memories on disk: one Markdown file per Memory with frontmatter, plus
 * `MEMORY.md`, the Memory index, rebuilt from those files on every change.
 * The layout matches Claude Code's auto memory, so files copy across by hand.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface Memory {
	name: string;
	description: string;
	type: MemoryType;
	body: string;
}

const INDEX_FILE = "MEMORY.md";
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The directory holding a Project's Memories: the Project's path with `/` turned into `-`. */
export function memoryDir(agentDir: string, project: string): string {
	return join(agentDir, "bluclawd", "memory", project.replaceAll("/", "-"));
}

/** Why `memory` can't be saved, or undefined when it can. */
export function invalidMemory(memory: Memory): string | undefined {
	if (!NAME.test(memory.name)) return `"${memory.name}" is not a kebab-case name (a-z, 0-9 and single hyphens).`;
	if (/[\r\n]/.test(memory.description) || !memory.description.trim()) return "The description must be one line.";
	if (!MEMORY_TYPES.includes(memory.type)) return `The type must be one of ${MEMORY_TYPES.join(", ")}.`;
	return undefined;
}

export function saveMemory(dir: string, memory: Memory): void {
	mkdirSync(dir, { recursive: true });
	const file = [
		"---",
		`name: ${memory.name}`,
		`description: ${memory.description.trim()}`,
		`type: ${memory.type}`,
		"---",
		"",
		memory.body.trim(),
		"",
	].join("\n");
	writeFileSync(join(dir, `${memory.name}.md`), file, "utf8");
	rebuildIndex(dir);
}

/** The Project's Memories by name, as their files say now (hand edits included). */
export function listMemories(dir: string): Array<{ name: string; type: string; description: string }> {
	return memoryFiles(dir).map((file) => {
		const { frontmatter } = parseFrontmatter<Record<string, unknown>>(readFileSync(join(dir, file), "utf8"));
		const field = (key: string) => (typeof frontmatter[key] === "string" ? frontmatter[key] : "");
		return { name: file.slice(0, -".md".length), type: field("type"), description: field("description") };
	});
}

/** Rewrites `MEMORY.md` from the Memory files, so concurrent writers can't leave it out of step. */
function rebuildIndex(dir: string): void {
	const lines = listMemories(dir).map(({ name, description }) => `- [${name}](${name}.md) — ${description}`);
	writeFileSync(join(dir, INDEX_FILE), lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
}

function memoryFiles(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((file) => file.endsWith(".md") && file !== INDEX_FILE)
			.sort();
	} catch {
		return [];
	}
}

/** The Memory index as stored, or "" when the Project has none. */
export function readIndex(dir: string): string {
	try {
		return readFileSync(join(dir, INDEX_FILE), "utf8");
	} catch {
		return "";
	}
}

/** A Memory's file as stored, or undefined when there is none by that name. */
export function readMemory(dir: string, name: string): string | undefined {
	if (!NAME.test(name)) return undefined;
	try {
		return readFileSync(join(dir, `${name}.md`), "utf8");
	} catch {
		return undefined;
	}
}

/** Removes a Memory; false when there is none by that name. */
export function deleteMemory(dir: string, name: string): boolean {
	if (readMemory(dir, name) === undefined) return false;
	rmSync(join(dir, `${name}.md`));
	rebuildIndex(dir);
	return true;
}

export const INDEX_MAX_LINES = 200;
export const INDEX_MAX_BYTES = 25 * 1024;

/** The Memory index cut to its first 200 lines or 25KB, whichever comes first, cutting only between lines. */
export function capIndex(index: string): { text: string; dropped: number } {
	const lines = index.split("\n").filter((line) => line.trim());
	const kept: string[] = [];
	let bytes = 0;
	for (const line of lines.slice(0, INDEX_MAX_LINES)) {
		bytes += Buffer.byteLength(`${line}\n`);
		if (bytes > INDEX_MAX_BYTES) break;
		kept.push(line);
	}
	return { text: kept.join("\n"), dropped: lines.length - kept.length };
}
