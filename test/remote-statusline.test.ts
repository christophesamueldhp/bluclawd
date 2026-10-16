import { describe, expect, it } from "vitest";
import {
	diffTotals,
	type GitRun,
	gitInfo,
	gitInfoCache,
	originOwner,
	statusLine,
} from "../daemon/remote/statusline.ts";

/** Answers each git command by its arguments; one it has no answer for fails, as git does. */
function fakeGit(answers: Record<string, string>): GitRun & { calls: string[] } {
	const calls: string[] = [];
	const run = async (cwd: string, args: string[]) => {
		calls.push(`${cwd}: ${args.join(" ")}`);
		const answer = answers[args.join(" ")];
		if (answer === undefined) throw new Error(`fatal: ${args.join(" ")}`);
		return answer;
	};
	return Object.assign(run, { calls });
}

const repo = {
	"branch --show-current": "main\n",
	"diff --numstat --no-ext-diff --no-textconv HEAD": "10\t2\tsrc/a.ts\n-\t-\tlogo.png\n3\t0\tREADME.md\n",
	"remote get-url origin": "git@github.com:christophe/bluclawd.git\n",
};

describe("git state for the status bar", () => {
	it("sums the lines added and removed, a binary file counting none", () => {
		expect(diffTotals("10\t2\ta\n-\t-\tb.png\n3\t0\tc\n")).toEqual({ added: 13, removed: 2 });
		expect(diffTotals("")).toEqual({ added: 0, removed: 0 });
	});

	it("takes the owner from an ssh, https or ssh:// origin, and nothing else of the URL", () => {
		expect(originOwner("git@github.com:christophe/bluclawd.git\n")).toBe("christophe");
		expect(originOwner("https://github.com/christophe/bluclawd")).toBe("christophe");
		expect(originOwner("https://user:secret@github.com/christophe/bluclawd.git")).toBe("christophe");
		expect(originOwner("ssh://git@github.com/christophe/bluclawd.git/")).toBe("christophe");
		expect(originOwner("")).toBeUndefined();
	});

	it("gives the branch, the origin's owner and the changes against HEAD", async () => {
		const run = fakeGit(repo);
		expect(await gitInfo("/p", run)).toEqual({ branch: "main", owner: "christophe", added: 13, removed: 2 });
		expect(run.calls.every((call) => call.startsWith("/p: "))).toBe(true);
	});

	it("gives nothing outside a repository", async () => {
		const run = fakeGit({});
		expect(await gitInfo("/tmp", run)).toBeUndefined();
		expect(run.calls).toEqual(["/tmp: branch --show-current"]);
	});

	it("names a detached HEAD by its commit, and leaves out what git cannot tell", async () => {
		const run = fakeGit({ "branch --show-current": "\n", "rev-parse --short HEAD": "a1b2c3d\n" });
		expect(await gitInfo("/p", run)).toEqual({ branch: "a1b2c3d", added: 0, removed: 0 });
	});

	it("runs git once per directory every few seconds, however often the phone asks", async () => {
		let now = 0;
		const run = fakeGit(repo);
		const cached = gitInfoCache(run, () => now);
		await Promise.all([cached("/p"), cached("/p")]);
		await cached("/p");
		expect(run.calls.filter((call) => call === "/p: branch --show-current")).toHaveLength(1);
		await cached("/q");
		expect(run.calls.filter((call) => call.endsWith("branch --show-current"))).toHaveLength(2);
		now = 5000;
		await cached("/p");
		expect(run.calls.filter((call) => call === "/p: branch --show-current")).toHaveLength(2);
	});
});

describe("the status beside a report", () => {
	it("is the directory's git state, left out when unknown", async () => {
		const git = { branch: "main", added: 1, removed: 0 };
		expect(await statusLine(async () => git)("/p")).toEqual({ git });
		expect(await statusLine(async () => undefined)("/p")).toEqual({});
	});
});
