import { afterEach, describe, expect, it, vi } from "vitest";
import {
	assertAllowedUrl,
	clearWebfetchCache,
	decodeBody,
	fetchGuardedRedirects,
	isPrivateIp,
	webFetch,
} from "../ext/web/fetch.ts";

const noDns = async (): Promise<void> => {};

function response(body: string | Uint8Array, init: { status?: number; headers?: Record<string, string> } = {}) {
	return new Response(body as BodyInit, {
		status: init.status ?? 200,
		headers: init.headers ?? { "content-type": "text/html" },
	});
}

afterEach(() => {
	clearWebfetchCache();
	vi.restoreAllMocks();
});

describe("SSRF guard", () => {
	it("classifies private and public addresses", () => {
		for (const ip of [
			"127.0.0.1",
			"10.1.2.3",
			"172.16.0.1",
			"192.168.1.1",
			"169.254.169.254",
			"::1",
			"fe80::1%en0",
			"::ffff:10.0.0.1",
		]) {
			expect(isPrivateIp(ip), ip).toBe(true);
		}
		for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111", "not-an-ip"]) {
			expect(isPrivateIp(ip), ip).toBe(false);
		}
	});

	it("rejects bad schemes, localhost, and literal private hosts up front", () => {
		expect(() => assertAllowedUrl("ftp://example.com")).toThrow(/unsupported scheme/);
		expect(() => assertAllowedUrl("http://localhost:3000")).toThrow(/localhost/);
		expect(() => assertAllowedUrl("http://[::1]/")).toThrow(/private address/);
		expect(() => assertAllowedUrl("http://169.254.169.254/latest")).toThrow(/private address/);
		expect(assertAllowedUrl("https://Example.com/a").hostname).toBe("example.com");
	});
});

describe("redirect handling", () => {
	it("follows same-host redirects, including an http→https upgrade", async () => {
		const seen: string[] = [];
		const fetchImpl = (async (input: URL | RequestInfo) => {
			const url = String(input);
			seen.push(url);
			if (url === "http://example.com/a")
				return response("", { status: 301, headers: { location: "https://example.com/b" } });
			if (url === "https://example.com/b") return response("", { status: 302, headers: { location: "/c" } });
			return response("<p>final</p>");
		}) as typeof fetch;
		const res = await fetchGuardedRedirects(new URL("http://example.com/a"), {}, fetchImpl, noDns);
		expect(res.status).toBe(200);
		expect(seen).toEqual(["http://example.com/a", "https://example.com/b", "https://example.com/c"]);
	});

	it("stops at a cross-host redirect and reports it instead of following", async () => {
		const seen: string[] = [];
		const fetchImpl = (async (input: URL | RequestInfo) => {
			seen.push(String(input));
			return response("", { status: 302, headers: { location: "https://other.example.org/x" } });
		}) as typeof fetch;
		const result = await webFetch("https://example.com/a", { fetchImpl, resolveHost: noDns });
		expect(seen).toEqual(["https://example.com/a"]);
		expect(result.redirectedTo).toBe("https://other.example.org/x");
		expect(result.text).toContain("Original URL: https://example.com/a");
		expect(result.text).toContain("Status: 302");
		expect(result.text).toContain("Redirects to: https://other.example.org/x");
	});

	it("does not cache a redirect notice", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls++;
			return response("", { status: 302, headers: { location: "https://other.example.org/x" } });
		}) as typeof fetch;
		await webFetch("https://example.com/a", { fetchImpl, resolveHost: noDns });
		await webFetch("https://example.com/a", { fetchImpl, resolveHost: noDns });
		expect(calls).toBe(2);
	});

	it("re-resolves the host on every hop, so a DNS answer that turns private mid-chain is refused", async () => {
		const fetchImpl = (async () =>
			response("", { status: 302, headers: { location: "http://example.com:8080/" } })) as typeof fetch;
		let lookups = 0;
		const resolveHost = async (): Promise<void> => {
			// First hop resolves public; the same host answers private on the second.
			if (++lookups === 2) throw new Error("webfetch: blocked private address 10.0.0.5 for example.com");
		};
		await expect(webFetch("https://example.com/a", { fetchImpl, resolveHost })).rejects.toThrow(
			/blocked private address/,
		);
		expect(lookups).toBe(2);
	});
});

describe("body decoding", () => {
	it("honours the charset in the content-type header", () => {
		const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café" in ISO-8859-1
		expect(decodeBody(latin1, "text/html; charset=iso-8859-1")).toBe("café");
		expect(decodeBody(latin1, "text/html")).not.toBe("café"); // utf-8 default garbles it
	});

	it("sniffs a <meta charset> when the header names none", () => {
		const html = '<html><head><meta charset="windows-1252"></head><body>caf\xe9</body></html>';
		const bytes = Uint8Array.from(html, (c) => c.charCodeAt(0));
		expect(decodeBody(bytes, "text/html")).toContain("café");
	});

	it("falls back to utf-8 on an unknown charset label", () => {
		const bytes = new TextEncoder().encode("ok");
		expect(decodeBody(bytes, "text/plain; charset=x-no-such-encoding")).toBe("ok");
	});

	it("decodes a fetched page with its declared charset and asks for text formats", async () => {
		let accept = "";
		const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => {
			accept = String((init?.headers as Record<string, string>)?.Accept ?? "");
			return response(new Uint8Array([0x3c, 0x70, 0x3e, 0x63, 0x61, 0x66, 0xe9, 0x3c, 0x2f, 0x70, 0x3e]), {
				headers: { "content-type": "text/html; charset=latin1" },
			});
		}) as typeof fetch;
		const result = await webFetch("https://example.com/", { fetchImpl, resolveHost: noDns });
		expect(result.text).toBe("café");
		expect(accept).toContain("text/html");
		expect(accept).toContain("text/markdown");
	});
});

describe("caching and limits", () => {
	it("serves a repeat fetch from the cache and caps the body", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls++;
			return response("0123456789", { headers: { "content-type": "text/plain" } });
		}) as typeof fetch;
		const first = await webFetch("https://example.com/", { fetchImpl, resolveHost: noDns, maxBytes: 4 });
		expect(first.text).toContain("0123");
		expect(first.text).not.toContain("4567");
		expect(first.truncated).toBe(true);
		const second = await webFetch("https://example.com/", { fetchImpl, resolveHost: noDns, maxBytes: 4 });
		expect(second.cached).toBe(true);
		expect(calls).toBe(1);
	});

	it("reports binary content instead of dumping it", async () => {
		const fetchImpl = (async () =>
			response(new Uint8Array(16), {
				headers: { "content-type": "image/png", "content-length": "16" },
			})) as typeof fetch;
		const result = await webFetch("https://example.com/i.png", { fetchImpl, resolveHost: noDns });
		expect(result.text).toMatch(/non-text content image\/png, 16 bytes/);
	});
});
