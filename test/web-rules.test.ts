import { describe, expect, it } from "vitest";
import { decide, exactRule, parseRuleSpec } from "../ext/permissions/rules.ts";

const call = (url: string) => ({ url });

describe("WebFetch(domain:…) rules", () => {
	it("matches by hostname, case-insensitively, regardless of path or port", () => {
		const rules = { allow: ["WebFetch(domain:example.com)"] };
		expect(decide(rules, "webfetch", call("https://Example.com/docs/a?b=c"))).toBe("allow");
		expect(decide(rules, "webfetch", call("http://example.com:8080/"))).toBe("allow");
		expect(decide(rules, "webfetch", call("https://docs.example.com/"))).toBeNull();
		expect(decide(rules, "webfetch", call("https://example.com.evil.net/"))).toBeNull();
	});

	it("globs the domain part so *.example.com covers subdomains", () => {
		const rules = { deny: ["WebFetch(domain:*.example.com)"] };
		expect(decide(rules, "webfetch", call("https://docs.example.com/x"))).toBe("deny");
		expect(decide(rules, "webfetch", call("https://example.com/x"))).toBeNull();
	});

	it("leaves a url-shaped rule working the way it always did", () => {
		const rules = { allow: ["WebFetch(https://example.com/**)"] };
		expect(decide(rules, "webfetch", call("https://example.com/a/b"))).toBe("allow");
		expect(decide(rules, "webfetch", call("https://example.org/"))).toBeNull();
	});

	it("never matches an unparsable url", () => {
		expect(decide({ allow: ["WebFetch(domain:*)"] }, "webfetch", call("not a url"))).toBeNull();
	});

	it("persists Always-allow as a domain rule, which is what makes it reusable", () => {
		expect(exactRule("webfetch", "https://Docs.Example.com/page?x=1")).toBe("WebFetch(domain:docs.example.com)");
		expect(exactRule("webfetch", "garbage")).toBe("WebFetch(garbage)");
		expect(exactRule("websearch", "how to x")).toBe("WebSearch(how to x)");
	});

	it("round-trips a domain spec through parseRuleSpec so /permissions add can validate it", () => {
		const parsed = parseRuleSpec("WebFetch(domain:example.com)");
		expect(parsed?.tool).toBe("webfetch");
		expect(decide({ allow: ["WebFetch(domain:example.com)"] }, "webfetch", parsed!.input)).toBe("allow");
		expect(parseRuleSpec("WebFetch(https://x.y/)")).toEqual({ tool: "webfetch", input: { url: "https://x.y/" } });
	});
});
