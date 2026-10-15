import { describe, expect, it } from "vitest";
import { filterSessions } from "../daemon/remote/web/search.js";

const session = (id: string, label: string, cwd: string, detail: string) => ({
	id,
	label,
	cwd,
	detail,
	band: "idle",
	state: "idle",
	alive: true,
	resumable: false,
});
const sessions = [
	session("a", "Fix the parser", "/Users/me/Projects/bluclawd", "ready"),
	session("b", "Write docs", "/Users/me/Projects/site", "Reading README.md"),
	session("c", "Refactor", "/Users/me/work/api", ""),
];
const ids = (query: string) => filterSessions(sessions, query).map((s) => s.id);

describe("searching the session list", () => {
	it("keeps the rows whose name, directory or detail has the query, whatever the case", () => {
		expect(ids("parser")).toEqual(["a"]);
		expect(ids("BLUCLAWD")).toEqual(["a"]);
		expect(ids("readme")).toEqual(["b"]);
		expect(ids("projects")).toEqual(["a", "b"]);
		expect(ids("  api ")).toEqual(["c"]);
	});

	it("keeps them all for an empty query, and none that match nothing", () => {
		expect(ids("")).toEqual(["a", "b", "c"]);
		expect(ids("   ")).toEqual(["a", "b", "c"]);
		expect(ids("nothing like it")).toEqual([]);
	});

	it("keeps the list's order, so the bands stay as they were", () => {
		expect(ids("e")).toEqual(["a", "b", "c"]);
	});
});
