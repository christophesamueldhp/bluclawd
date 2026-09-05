import { describe, expect, it } from "vitest";
import { capForInjection, expandImports, formatFact, projectSlug, searchMemory } from "../ext/memory/index.ts";

const MEM = "/agent/memory";

/** Stand-in for the filesystem, so these stay pure. */
const files = (entries: Record<string, string>) => (path: string) => entries[path];

describe("formatFact", () => {
	it("writes a single-line note as one bullet", () => {
		expect(formatFact("ship on friday")).toBe("- ship on friday");
	});

	it("keeps a multi-line note as ONE bullet by indenting continuations", () => {
		expect(formatFact("deploy steps\nrun migrations\nflip the flag")).toBe(
			"- deploy steps\n  run migrations\n  flip the flag",
		);
	});

	it("does not indent blank separator lines", () => {
		expect(formatFact("first\n\nsecond")).toBe("- first\n\n  second");
	});
});

describe("expandImports", () => {
	const read = files({ [`${MEM}/deploy.md`]: "# Deploy\nrun migrations\n" });

	it("expands a pointer to a sibling note", () => {
		expect(expandImports("@deploy.md", MEM, read)).toBe("# Deploy\nrun migrations");
		expect(expandImports("- @deploy.md", MEM, read)).toBe("# Deploy\nrun migrations");
	});

	it("leaves surrounding lines untouched", () => {
		expect(expandImports("before\n@deploy.md\nafter", MEM, read)).toBe("before\n# Deploy\nrun migrations\nafter");
	});

	it("refuses to read outside the memory directory", () => {
		// The `memory` tool lets the MODEL write these lines, so an escaping path would
		// be an arbitrary-file-read the agent could grant itself.
		const escaping = files({ "/etc/passwd.md": "SECRET", "/agent/other.md": "SECRET" });
		expect(expandImports("@../other.md", MEM, escaping)).toBe("@../other.md");
		expect(expandImports("@/etc/passwd.md", MEM, escaping)).toBe("@/etc/passwd.md");
		expect(expandImports("@../../etc/passwd.md", MEM, escaping)).toBe("@../../etc/passwd.md");
	});

	it("only expands .md targets", () => {
		const other = files({ [`${MEM}/.env`]: "TOKEN=abc", [`${MEM}/notes.txt`]: "text" });
		expect(expandImports("@.env", MEM, other)).toBe("@.env");
		expect(expandImports("@notes.txt", MEM, other)).toBe("@notes.txt");
	});

	it("does not recurse, so imports cannot cycle", () => {
		const cyclic = files({ [`${MEM}/a.md`]: "@b.md", [`${MEM}/b.md`]: "@a.md" });
		expect(expandImports("@a.md", MEM, cyclic)).toBe("@b.md");
	});

	it("leaves a missing or unreadable target visible instead of dropping it", () => {
		expect(expandImports("@gone.md", MEM, files({}))).toBe("@gone.md");
	});

	it("ignores lines that merely mention an @path", () => {
		expect(expandImports("see @deploy.md for details", MEM, read)).toBe("see @deploy.md for details");
	});
});

describe("searchMemory", () => {
	const bodies = [
		{ scope: "global" as const, body: "- prefers uv\n- writes English" },
		{ scope: "project" as const, body: "- uses vitest\n- UV pinned here" },
	];

	it("matches case-insensitively across scopes, with 1-based line numbers", () => {
		expect(searchMemory(bodies, "uv")).toEqual([
			{ scope: "global", line: 1, text: "- prefers uv" },
			{ scope: "project", line: 2, text: "- UV pinned here" },
		]);
	});

	it("returns nothing for an empty query or an absent body", () => {
		expect(searchMemory(bodies, "   ")).toEqual([]);
		expect(searchMemory([{ scope: "global", body: undefined }], "uv")).toEqual([]);
	});
});

describe("injection budget", () => {
	it("passes a small body through untouched", () => {
		expect(capForInjection("- one\n- two")).toBe("- one\n- two");
	});

	it("truncates a long body and says where the rest is", () => {
		const capped = capForInjection(Array.from({ length: 250 }, (_, i) => `- ${i}`).join("\n"));
		expect(capped.split("\n")).toHaveLength(201);
		expect(capped).toContain("/memory shows the full file");
	});
});

describe("projectSlug", () => {
	it("flattens a path into a filesystem-safe directory name", () => {
		expect(projectSlug("/home/me/src/app")).toBe("-home-me-src-app");
	});
});
