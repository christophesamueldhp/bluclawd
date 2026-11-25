import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;

export interface Memory {
	name: string;
	description: string;
	type: (typeof MEMORY_TYPES)[number];
	body: string;
}

export interface MemoryAsFound {
	name: string;
	type: string;
	description: string;
}

const INDEX_FILE = "MEMORY.md";
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const INDEX_MAX_LINES = 200;
const INDEX_MAX_BYTES = 25 * 1024;

export function memoryDir(agentDir: string, project: string): string {
	return join(agentDir, "bluclawd", "memory", project.replaceAll("/", "-"));
}

export function invalidMemory(memory: Memory): string | undefined {
	if (!NAME.test(memory.name)) return `"${memory.name}" is not a kebab-case name (a-z, 0-9 and single hyphens).`;
	if (/[\r\n]/.test(memory.description) || !memory.description.trim()) return "The description must be one line.";
	if (!MEMORY_TYPES.includes(memory.type)) return `The type must be one of ${MEMORY_TYPES.join(", ")}.`;
	return undefined;
}

function writeAtomically(path: string, content: string): void {
	const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(temporary, content, "utf8");
	renameSync(temporary, path);
}

const yamlString = (text: string) => JSON.stringify(text);

export function saveMemory(dir: string, memory: Memory): void {
	mkdirSync(dir, { recursive: true });
	const file = [
		"---",
		`name: ${memory.name}`,
		`description: ${yamlString(memory.description.trim())}`,
		`type: ${memory.type}`,
		"---",
		"",
		memory.body.trim(),
		"",
	].join("\n");
	writeAtomically(join(dir, `${memory.name}.md`), file);
	rebuildIndex(dir);
}

export function listMemories(dir: string): MemoryAsFound[] {
	return memoryFiles(dir).map((file) => {
		const name = file.slice(0, -".md".length);
		try {
			const { frontmatter } = parseFrontmatter<Record<string, unknown>>(readFileSync(join(dir, file), "utf8"));
			const field = (key: string) => (frontmatter[key] === undefined ? "" : String(frontmatter[key]));
			return { name, type: field("type"), description: field("description") };
		} catch {
			return { name, type: "", description: "(unreadable frontmatter: fix or delete this file)" };
		}
	});
}

function rebuildIndex(dir: string): void {
	const lines = listMemories(dir).map(({ name, description }) => `- [${name}](${name}.md) — ${description}`);
	writeAtomically(join(dir, INDEX_FILE), lines.length > 0 ? `${lines.join("\n")}\n` : "");
}

function memoryFiles(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((file) => file.endsWith(".md") && NAME.test(file.slice(0, -".md".length)))
			.sort();
	} catch {
		return [];
	}
}

export function readIndex(dir: string): string {
	try {
		return readFileSync(join(dir, INDEX_FILE), "utf8");
	} catch {
		return "";
	}
}

export function readMemory(dir: string, name: string): string | undefined {
	if (!NAME.test(name)) return undefined;
	try {
		return readFileSync(join(dir, `${name}.md`), "utf8");
	} catch {
		return undefined;
	}
}

export function deleteMemory(dir: string, name: string): boolean {
	if (readMemory(dir, name) === undefined) return false;
	rmSync(join(dir, `${name}.md`));
	rebuildIndex(dir);
	return true;
}

export function capIndex(index: string): { kept: string; dropped: number } {
	const lines = index.split("\n").filter((line) => line.trim());
	const kept: string[] = [];
	let bytes = 0;
	for (const line of lines.slice(0, INDEX_MAX_LINES)) {
		bytes += Buffer.byteLength(`${line}\n`);
		if (bytes > INDEX_MAX_BYTES) break;
		kept.push(line);
	}
	return { kept: kept.join("\n"), dropped: lines.length - kept.length };
}
