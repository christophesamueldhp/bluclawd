import { describe, expect, it } from "vitest";
import { diffCounts, diffHtml, lineKind } from "#remote-web/diff.js";

// As pi's edit tool writes it: line numbers padded to one width, a gap line between hunks.
const diff = [" 1 import a", "-2 const x = 1;", "+2 const x = 2;", "+3 const y = 3;", "   ...", " 9 export {};"].join(
	"\n",
);

describe("an edit's diff on the phone", () => {
	it("tells added, removed and context lines apart by their first character", () => {
		expect(diff.split("\n").map(lineKind)).toEqual(["ctx", "del", "add", "add", "ctx", "ctx"]);
		// What follows the sign is the line's own text, whatever it holds.
		expect(lineKind("+1 -- a comment")).toBe("add");
		expect(lineKind("-1 ++i;")).toBe("del");
		expect(lineKind("")).toBe("ctx");
	});

	it("counts the lines it adds and removes", () => {
		expect(diffCounts(diff)).toEqual({ added: 2, removed: 1 });
		expect(diffCounts(" 1 same")).toEqual({ added: 0, removed: 0 });
	});

	it("colours each line by a class, escaped, and says when it was cut short", () => {
		const html = diffHtml('-1 <b class="x">&</b>\n+1 ok');
		expect(html).toBe(
			'<pre class="diff"><span class="del">-1 &#60;b class=&#34;x&#34;&#62;&#38;&#60;/b&#62;</span>\n<span class="add">+1 ok</span></pre>',
		);
		expect(diffHtml("+1 a…", true)).toContain('<p class="note">The diff is cut short here.</p>');
	});
});
