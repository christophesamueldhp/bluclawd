import { describe, expect, it } from "vitest";
import { filterSessions, fold, matchCommands } from "../daemon/remote/web/search.js";

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
	session("a", "Fix the parser", "/Users/christophesamueldhp/Projects/bluclawd", "ready"),
	session("b", "Write docs", "/Users/christophesamueldhp/Projects/site", "Reading README.md"),
	session("c", "Refactor", "/Users/christophesamueldhp/work/api", ""),
	session("d", "Café menu", "/home/me/Projects/crème-brûlée", "idle"),
];
const ids = (query: string) => filterSessions(sessions, query).map((s) => s.id);

describe("searching the session list", () => {
	it("keeps the rows whose name, directory or detail has a word starting with the query, whatever the case", () => {
		expect(ids("parser")).toEqual(["a"]);
		expect(ids("BLUCLAWD")).toEqual(["a"]);
		expect(ids("readme")).toEqual(["b"]);
		expect(ids("projects")).toEqual(["a", "b", "d"]);
		expect(ids("  api ")).toEqual(["c"]);
	});

	it("filters from the first letter by words' starts: a letter inside a word, or the home folder, does not match", () => {
		// "Reading README.md" has a "d" and "Fix the parser" an "e" inside a word; "/Users/christophesamueldhp" both.
		expect(ids("c")).toEqual(["d"]);
		expect(ids("d")).toEqual(["b"]);
		expect(ids("e")).toEqual([]);
		expect(ids("w")).toEqual(["b", "c"]);
		expect(ids("b")).toEqual(["a", "d"]);
	});

	it("matches every field by its words' starts", () => {
		expect(ids("blu")).toEqual(["a"]);
		expect(ids("clawd")).toEqual([]);
		expect(ids("work")).toEqual(["c"]);
		expect(ids("arser")).toEqual([]);
		expect(ids("readme.md")).toEqual(["b"]);
	});

	it("ignores accents, either way round", () => {
		expect(ids("cafe")).toEqual(["d"]);
		expect(ids("CAFÉ")).toEqual(["d"]);
		expect(ids("creme")).toEqual(["d"]);
		expect(fold("Crème Brûlée")).toBe("creme brulee");
	});

	it("keeps only the rows that have every word, in any field", () => {
		expect(ids("fix bluclawd")).toEqual(["a"]);
		expect(ids("docs readme")).toEqual(["b"]);
		expect(ids("fix site")).toEqual([]);
	});

	it("keeps them all for an empty query, and none that match nothing", () => {
		expect(ids("")).toEqual(["a", "b", "c", "d"]);
		expect(ids("   ")).toEqual(["a", "b", "c", "d"]);
		expect(ids("nothing like it")).toEqual([]);
	});

	it("keeps the list's order, so the bands stay as they were", () => {
		expect(ids("p")).toEqual(["a", "b", "d"]);
	});
});

describe("suggesting the session's commands", () => {
	const commands = [
		{ name: "compact", description: "Compact the context" },
		{ name: "/model", description: "Switch the model" },
		{ name: "remote-control" },
		{ name: "agent-view" },
		{ name: "exit", source: "builtin" as const },
		{ name: "reload" },
		{ name: "review" },
	];
	const names = (text: string) => matchCommands(commands, text).map((c) => c.name);

	it("offers those whose name starts with what is typed after the /", () => {
		expect(names("/")).toEqual(["compact", "/model", "reload", "review"]);
		expect(names("/re")).toEqual(["reload", "review"]);
		expect(names("/RE")).toEqual(["reload", "review"]);
		expect(names("/mod")).toEqual(["/model"]);
		expect(names("/x")).toEqual([]);
	});

	it("offers nothing once the name is followed by more, or without a leading /", () => {
		expect(names("/compact ")).toEqual([]);
		expect(names("/review the diff")).toEqual([]);
		expect(names("re")).toEqual([]);
		expect(names(" /re")).toEqual([]);
		expect(names("")).toEqual([]);
	});

	it("never offers the commands the phone refuses to send", () => {
		expect(names("/remote")).toEqual([]);
		expect(names("/agent")).toEqual([]);
		// The Mac refuses it from a phone.
		expect(names("/ex")).toEqual([]);
	});

	it("offers nothing when the session reports no commands", () => {
		expect(matchCommands(undefined, "/")).toEqual([]);
		expect(matchCommands([], "/")).toEqual([]);
	});

	it("offers a handful at most", () => {
		const many = Array.from({ length: 20 }, (_, i) => ({ name: `cmd${i}` }));
		expect(matchCommands(many, "/cmd")).toHaveLength(6);
	});
});
