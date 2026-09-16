/**
 * `webfetch` implementation (PLAN.md F4.2): fetch a URL and return it as text /
 * Markdown for the model, with an SSRF guard.
 *
 * A coding agent follows model instructions, so `webfetch` is prompt-injectable:
 * it must never reach internal services (cloud metadata 169.254.169.254,
 * localhost, RFC-1918, ...), INCLUDING via a public URL that 3xx-redirects to a
 * private IP. Two layers enforce this:
 *   1. `assertAllowedUrl` — a fast, pure, DNS-free reject of bad schemes,
 *      localhost, and literal private-IP hosts.
 *   2. A DNS guard on the original request AND every redirect hop. Redirects are
 *      always followed manually (`fetchGuardedRedirects`) with `assertAllowedUrl`
 *      + an all-addresses DNS validation per hop, and a hop to a DIFFERENT host
 *      is reported back to the model rather than followed (Claude Code parity):
 *      a `WebFetch(domain:…)` rule approved one host, and a 302 must not be able
 *      to turn that into a fetch of any other.
 *      - Node additionally routes every hop through a per-request undici
 *        dispatcher whose `connect.lookup` validates the CONNECTED IP
 *        (TOCTOU-safe — undici connects to exactly the address the lookup
 *        returned).
 *      - Bun's native fetch IGNORES undici's `dispatcher`, so it has only the
 *        per-hop DNS check. Residual TOCTOU: Bun re-resolves internally, so a
 *        DNS answer could change between the check and the connect — far
 *        narrower than no guard, but weaker than Node's connect-layer path.
 */

import { randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import { lookup as dnsLookupAsync } from "node:dns/promises";
import { writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatSize,
	DEFAULT_MAX_BYTES as INLINE_MAX_BYTES,
	truncateHead,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import { Agent, fetch as undiciFetch } from "undici";
import { fetchGithub, type GithubRunner, parseGithubUrl } from "./github.ts";
import { pdfToText } from "./pdf.ts";
import { readableMarkdown } from "./readable.ts";
import { fetchYoutube, parseYoutubeId } from "./youtube.ts";

const USER_AGENT = `pi/${VERSION}`;
// Prefer prose the converter handles well; text/markdown is what a growing number
// of docs hosts serve to agents that ask for it, sparing the HTML round-trip.
const ACCEPT =
	"text/html, application/xhtml+xml, text/markdown;q=0.9, text/plain;q=0.8, application/json;q=0.7, */*;q=0.5";
const DEFAULT_MAX_BYTES = 2_000_000;
// Hard ceiling regardless of a caller-supplied maxBytes: `webfetch` is
// prompt-injectable, so a runaway request must not be able to buffer an
// arbitrarily large body into the parent context.
const MAX_ALLOWED_BYTES = 8_000_000;
const TIMEOUT_MS = 30_000;

export interface WebfetchResult {
	url: string;
	contentType: string;
	bytes: number;
	truncated: boolean;
	text: string;
	/** True when served from the in-memory 15-minute cache. */
	cached?: boolean;
	/** Set when the URL redirected to another host: `text` is a notice, nothing was fetched from it. */
	redirectedTo?: string;
	/** Set when the page was too long to inline: `text` is its head, this file holds all of it. */
	fullTextPath?: string;
	/** Our own pointer to `fullTextPath`, kept apart from `text` so the page cannot forge one. */
	note?: string;
	/** An image response, for the tool to attach; `text` is empty. Never cached. */
	image?: { bytes: Uint8Array; mimeType: string };
}

/**
 * Hold a page to the limit pi's own read and bash tools keep (2000 lines / 50KB):
 * anything longer is written to a temp file and only its head is returned, with
 * a footer pointing `read` at the rest. The network cap (`maxBytes`) is a
 * separate, much larger bound on what is downloaded.
 */
function inlineOrSpill(text: string): { text: string; fullTextPath?: string; note?: string } {
	const head = truncateHead(text);
	if (!head.truncated) return { text };
	const fullTextPath = join(tmpdir(), `bluclawd-webfetch-${randomBytes(8).toString("hex")}.md`);
	writeFileSync(fullTextPath, text, { mode: 0o600 });
	const size = formatSize(head.totalBytes);
	if (head.firstLineExceedsLimit) {
		return {
			text: Buffer.from(text).subarray(0, INLINE_MAX_BYTES).toString(),
			fullTextPath,
			note: `[webfetch: page is one ${size} line; showing its start. Full content: ${fullTextPath} — search it with grep.]`,
		};
	}
	return {
		text: head.content,
		fullTextPath,
		note: `[webfetch: showing lines 1-${head.outputLines} of ${head.totalLines} (${size} total). Full content: ${fullTextPath} — use read with offset=${head.outputLines + 1} to continue.]`,
	};
}

// ── 15-minute result cache (CC parity, audit B.9) ───────────────────────────
// Process-local and keyed by URL+byte cap; only successful text results are
// cached (binary notes and errors are not). Bounded so a long session cannot
// accumulate page bodies without limit.
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_ENTRIES = 50;
const fetchCache = new Map<string, { at: number; result: WebfetchResult }>();

/** Drop every cached webfetch result (used by tests). */
export function clearWebfetchCache(): void {
	fetchCache.clear();
}

function cacheGet(key: string): WebfetchResult | undefined {
	const entry = fetchCache.get(key);
	if (!entry) return undefined;
	if (Date.now() - entry.at >= CACHE_TTL_MS) {
		fetchCache.delete(key);
		return undefined;
	}
	return { ...entry.result, cached: true };
}

function cacheSet(key: string, result: WebfetchResult): void {
	for (const [k, entry] of fetchCache) {
		if (Date.now() - entry.at >= CACHE_TTL_MS) fetchCache.delete(k);
	}
	// Still full after pruning: drop the oldest (Map preserves insertion order).
	while (fetchCache.size >= CACHE_MAX_ENTRIES) {
		const oldest = fetchCache.keys().next().value;
		if (oldest === undefined) break;
		fetchCache.delete(oldest);
	}
	fetchCache.set(key, { at: Date.now(), result });
}

// ── SSRF: private-IP classification ─────────────────────────────────────────

function ipv4ToInt(ip: string): number | null {
	const parts = ip.split(".");
	if (parts.length !== 4) return null;
	let n = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const v = Number(part);
		if (v > 255) return null;
		n = n * 256 + v;
	}
	return n >>> 0;
}

function inCidr4(ipInt: number, base: string, bits: number): boolean {
	const baseInt = ipv4ToInt(base);
	if (baseInt === null) return false;
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
	return (ipInt & mask) === (baseInt & mask);
}

// Non-public / special-use IPv4 ranges (loopback, RFC-1918, link-local incl.
// cloud metadata 169.254.169.254, CGNAT, multicast, reserved, ...).
const PRIVATE_V4: Array<[string, number]> = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
];

function isPrivateIpv4(ip: string): boolean {
	const n = ipv4ToInt(ip);
	if (n === null) return false;
	return PRIVATE_V4.some(([base, bits]) => inCidr4(n, base, bits));
}

/** Expand an IPv6 literal (with optional embedded IPv4) to eight zero-padded hextets, or null. */
function expandIpv6(addr: string): string[] | null {
	if (isIP(addr) !== 6) return null;
	let a = addr;
	// Rewrite a trailing embedded IPv4 (e.g. ::ffff:1.2.3.4) into two hextets.
	const v4 = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(a);
	if (v4) {
		const n = ipv4ToInt(v4[1]);
		if (n === null) return null;
		const hex = n.toString(16).padStart(8, "0");
		a = `${a.slice(0, v4.index)}:${hex.slice(0, 4)}:${hex.slice(4)}`;
	}
	const dbl = a.indexOf("::");
	let head: string[];
	let tail: string[];
	if (dbl >= 0) {
		head = a.slice(0, dbl).split(":").filter(Boolean);
		tail = a
			.slice(dbl + 2)
			.split(":")
			.filter(Boolean);
	} else {
		head = a.split(":");
		tail = [];
	}
	const missing = 8 - head.length - tail.length;
	if (missing < 0) return null;
	const groups = [...head, ...Array(missing).fill("0"), ...tail];
	if (groups.length !== 8) return null;
	return groups.map((g) => g.padStart(4, "0").toLowerCase());
}

function isPrivateIpv6(ip: string): boolean {
	const groups = expandIpv6(ip);
	if (!groups) return false;
	// IPv4-mapped ::ffff:a.b.c.d — re-check the embedded IPv4.
	if (groups.slice(0, 5).every((g) => g === "0000") && groups[5] === "ffff") {
		const hi = Number.parseInt(groups[6], 16);
		const lo = Number.parseInt(groups[7], 16);
		return isPrivateIpv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
	}
	if (groups.every((g) => g === "0000")) return true; // ::
	if (groups.slice(0, 7).every((g) => g === "0000") && groups[7] === "0001") return true; // ::1
	const first = Number.parseInt(groups[0], 16);
	if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
	if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7  unique-local
	if ((first & 0xff00) === 0xff00) return true; // ff00::/8  multicast
	if (groups[0] === "2001" && groups[1] === "0db8") return true; // 2001:db8::/32 documentation
	return false;
}

/**
 * True for any IP that must not be reachable from `webfetch`. Pure and DNS-free:
 * this is the unit-tested heart of the SSRF guard. Accepts a bare IP literal
 * (IPv4, IPv6, or IPv4-mapped IPv6); anything that is not a valid IP → false.
 */
export function isPrivateIp(ip: string): boolean {
	const clean = ip.split("%")[0]; // strip an IPv6 zone id (fe80::1%eth0)
	const fam = isIP(clean);
	if (fam === 4) return isPrivateIpv4(clean);
	if (fam === 6) return isPrivateIpv6(clean);
	return false;
}

/** Decides whether an address must not be reached. */
export type BlockedIp = (ip: string) => boolean;

function cidrMatcher(cidr: string): (ip: string) => boolean {
	const [base, bitsText, extra] = cidr.trim().split("/");
	const bits = Number(bitsText);
	const family = isIP(base ?? "");
	const maxBits = family === 4 ? 32 : 128;
	if (extra !== undefined || !family || !/^\d+$/.test(bitsText ?? "") || bits > maxBits) {
		throw new Error(`webfetch: invalid CIDR in allowRanges: ${cidr}`);
	}
	if (family === 4) {
		return (ip) => {
			const n = ipv4ToInt(ip);
			return n !== null && inCidr4(n, base, bits);
		};
	}
	const baseGroups = expandIpv6(base) as string[];
	return (ip) => {
		const groups = expandIpv6(ip);
		if (!groups) return false;
		for (let bit = 0; bit < bits; bit++) {
			const g = Math.floor(bit / 16);
			const mask = 0x8000 >> (bit % 16);
			if ((Number.parseInt(groups[g], 16) & mask) !== (Number.parseInt(baseGroups[g], 16) & mask)) return false;
		}
		return true;
	};
}

/**
 * The private-address block with the user's `allowRanges` carved out, for
 * proxies that hand out fake IPs (e.g. 198.18.0.0/15). An IPv4-mapped IPv6
 * address is matched as the IPv4 it carries. Throws on a malformed range.
 */
export function blockedExcept(allowRanges: string[]): BlockedIp {
	const matchers = allowRanges.map(cidrMatcher);
	return (ip) => {
		if (!isPrivateIp(ip)) return false;
		const clean = ip.split("%")[0];
		const groups = isIP(clean) === 6 ? expandIpv6(clean) : null;
		const mapped =
			groups?.slice(0, 5).every((g) => g === "0000") && groups[5] === "ffff"
				? [groups[6], groups[7]]
						.map((g) => Number.parseInt(g, 16))
						.flatMap((n) => [(n >> 8) & 0xff, n & 0xff])
						.join(".")
				: undefined;
		return !matchers.some((match) => match(clean) || (mapped !== undefined && match(mapped)));
	};
}

/**
 * Parse `urlStr` and reject it up front for an unsupported scheme, localhost, or
 * a literal private-IP host. Pure (no DNS). Returns the parsed URL when allowed.
 */
export function assertAllowedUrl(urlStr: string, isBlocked: BlockedIp = isPrivateIp): URL {
	let url: URL;
	try {
		url = new URL(urlStr);
	} catch {
		throw new Error(`webfetch: invalid URL: ${urlStr}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`webfetch: unsupported scheme "${url.protocol}" (only http and https are allowed)`);
	}
	const host = url.hostname.toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost")) {
		throw new Error("webfetch: refusing to fetch localhost");
	}
	// WHATWG URL keeps IPv6 hosts in brackets ([::1]); strip them for isIP.
	const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	if (isIP(bare) && isBlocked(bare)) {
		throw new Error(`webfetch: refusing to fetch private address ${bare}`);
	}
	return url;
}

/** dns.lookup narrowed to the all-addresses overload (injectable for tests). */
type DnsLookupAll = (
	hostname: string,
	options: { all: true } & Record<string, unknown>,
	callback: (err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => void,
) => void;

type LookupCallback = (
	err: NodeJS.ErrnoException | null,
	address: string | Array<{ address: string; family: number }>,
	family?: number,
) => void;

/**
 * The connect-layer DNS validator behind `makeSafeAgent`: resolves ALL addresses,
 * rejects if any is private, and answers in the shape the caller asked for.
 * Exported for tests (the live undici wiring needs real DNS + network).
 */
export function makeValidatingLookup(
	lookupImpl: DnsLookupAll = dnsLookup as unknown as DnsLookupAll,
	isBlocked: BlockedIp = isPrivateIp,
) {
	return (hostname: string, options: { all?: boolean } & Record<string, unknown>, cb: LookupCallback): void => {
		lookupImpl(hostname, { ...options, all: true }, (err, addresses) => {
			if (err) return cb(err, "", 0);
			const list = Array.isArray(addresses) ? addresses : [{ address: String(addresses), family: 4 }];
			if (list.length === 0) return cb(new Error(`no addresses for ${hostname}`), "", 0);
			for (const a of list) {
				if (isBlocked(a.address)) {
					return cb(new Error(`blocked private address ${a.address} for ${hostname}`), "", 0);
				}
			}
			// Answer in the shape the caller asked for: with autoSelectFamily (Node's
			// default) net.connect requests all:true and expects the ARRAY form —
			// answering single-form there breaks every request (ERR_INVALID_IP_ADDRESS).
			if (options.all) return cb(null, list);
			cb(null, list[0].address, list[0].family);
		});
	};
}

/**
 * A per-request undici dispatcher whose DNS lookup rejects any hostname that
 * resolves to a private IP. Runs on the original request and on every redirect
 * hop, so a public URL redirecting to 169.254.169.254 is blocked at connect time.
 */
function makeSafeAgent(isBlocked: BlockedIp): Agent {
	return new Agent({
		connect: {
			lookup: makeValidatingLookup(undefined, isBlocked) as never,
		},
	});
}

/** Bun's native fetch ignores undici's `dispatcher`, so the connect-layer guard
 * never runs there — only the per-hop DNS check in `fetchGuardedRedirects` does. */
const IS_BUN = typeof process.versions.bun === "string";

/** Max redirect hops (undici's own default is 20; tighter is safer for a
 * prompt-injectable tool). */
const MAX_REDIRECTS = 5;

/**
 * Resolve `hostname` and throw if ANY of its addresses is private. Literal IPs
 * pass through (already vetted by `assertAllowedUrl`).
 */
async function assertPublicDns(hostname: string, isBlocked: BlockedIp = isPrivateIp): Promise<void> {
	const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
	if (isIP(bare)) return;
	const addresses = await dnsLookupAsync(bare, { all: true, verbatim: true });
	if (addresses.length === 0) throw new Error(`webfetch: no addresses for ${hostname}`);
	for (const a of addresses) {
		if (isBlocked(a.address)) {
			throw new Error(`webfetch: blocked private address ${a.address} for ${hostname}`);
		}
	}
}

/** Thrown by `fetchGuardedRedirects` when a hop leaves the original host. */
export class CrossHostRedirect extends Error {
	from: string;
	status: number;
	to: string;
	constructor(from: string, status: number, to: string) {
		super(`webfetch: ${from} redirects (${status}) to another host: ${to}`);
		this.from = from;
		this.status = status;
		this.to = to;
	}
}

/**
 * Fetch with redirect:"manual" and follow up to MAX_REDIRECTS hops, running
 * `assertAllowedUrl` (scheme / localhost / literal-IP) plus an all-addresses DNS
 * validation on EVERY hop. Same-host hops (a path move, an http→https upgrade)
 * are followed; a hop to another host throws `CrossHostRedirect` so the caller
 * can report it instead. Exported for tests (fetchImpl/resolveHost injectable).
 */
export async function fetchGuardedRedirects(
	url: URL,
	init: RequestInit,
	fetchImpl: typeof fetch,
	resolveHost: (hostname: string) => Promise<void> = assertPublicDns,
	isBlocked: BlockedIp = isPrivateIp,
): Promise<Response> {
	let current = url;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		await resolveHost(current.hostname);
		const res = await fetchImpl(current, { ...init, redirect: "manual" });
		const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
		if (location === null) return res;
		await res.body?.cancel().catch(() => {});
		const next = assertAllowedUrl(new URL(location, current).href, isBlocked);
		if (next.hostname !== current.hostname) throw new CrossHostRedirect(current.href, res.status, next.href);
		current = next;
	}
	throw new Error(`webfetch: too many redirects for ${url.href}`);
}

// ── content handling ────────────────────────────────────────────────────────

/** Image types a model can take as an attachment. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function classifyContentType(contentType: string, url: URL): "html" | "text" | "pdf" | "image" | "binary" {
	const type = contentType.split(";")[0].trim().toLowerCase();
	if (type === "text/html" || type === "application/xhtml+xml") return "html";
	if (type === "application/pdf") return "pdf";
	// Plenty of hosts serve PDFs as a generic download.
	if ((type === "application/octet-stream" || type === "binary/octet-stream") && /\.pdf$/i.test(url.pathname))
		return "pdf";
	if (IMAGE_TYPES.has(type)) return "image";
	if (type === "") return "text"; // missing content-type: assume text (best-effort)
	if (type.startsWith("text/")) return "text";
	if (type === "application/json" || type.endsWith("+json")) return "text";
	if (type === "application/xml" || type.endsWith("+xml")) return "text";
	if (type === "application/javascript" || type === "application/ecmascript") return "text";
	return "binary";
}

/** `charset=` from a content-type header or a <meta> tag's content attribute. */
function charsetParam(value: string): string | undefined {
	return /charset\s*=\s*["']?([\w.:-]+)/i.exec(value)?.[1];
}

/**
 * Decode a body with the charset the response declares — the content-type
 * header first, then a `<meta charset>` / `<meta http-equiv>` in the first
 * 2KB — falling back to utf-8 for none or an unknown label. Exported for tests.
 */
export function decodeBody(bytes: Uint8Array, contentType: string): string {
	let label = charsetParam(contentType);
	if (!label) {
		// Sniff as latin1: every byte maps to one char, so the ASCII markup is intact.
		const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
		label = /<meta\b[^>]*\bcharset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
	}
	if (label) {
		try {
			return new TextDecoder(label, { fatal: false }).decode(bytes);
		} catch {
			// Unknown or unsupported label: fall through to utf-8.
		}
	}
	return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Read the response body, stopping once `cap` bytes are collected. */
async function readCappedBody(res: Response, cap: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	const body = res.body;
	if (!body) {
		const buf = new Uint8Array(await res.arrayBuffer());
		return buf.length > cap ? { bytes: buf.subarray(0, cap), truncated: true } : { bytes: buf, truncated: false };
	}
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value?.length) continue;
			const remaining = cap - total;
			if (value.length >= remaining) {
				chunks.push(value.subarray(0, remaining));
				total += remaining;
				truncated = true; // more bytes were available than the cap allows
				break;
			}
			chunks.push(value);
			total += value.length;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return { bytes: out, truncated };
}

/**
 * Node wraps dispatcher/connect failures in TypeError("fetch failed") with the
 * real reason buried in the `cause` chain — unwrap it so the model sees
 * "blocked private address …" instead of an opaque "fetch failed". Abort/timeout
 * errors and errors without a cause chain pass through unchanged.
 */
function unwrapFetchError(err: unknown): Error {
	if (!(err instanceof Error)) return new Error(`webfetch: ${String(err)}`);
	if (err.name === "AbortError" || err.name === "TimeoutError") return err;
	let deepest: Error = err;
	while (deepest.cause instanceof Error) deepest = deepest.cause;
	if (deepest === err) return err;
	return new Error(deepest.message.startsWith("webfetch") ? deepest.message : `webfetch: ${deepest.message}`);
}

/**
 * Fetch `urlStr` and return it as text/Markdown. Throws on any failure (bad
 * scheme, private IP, network error, non-2xx) — never returns an error as success.
 *
 * A redirect to another host is not followed: the result carries `redirectedTo`
 * and a notice as `text`, and is not cached, so the model can decide whether
 * to fetch the new location.
 *
 * `fetchImpl` / `resolveHost` are injectable for tests. The default fetch is
 * runtime-dependent:
 *   - Node: the pinned undici package's own fetch — it must share an instance
 *     with `makeSafeAgent`'s Agent, because Node's BUILT-IN fetch given a
 *     foreign-instance dispatcher silently skips response decompression
 *     (content-encoding gets stripped while the body stays compressed).
 *   - Bun: the native fetch (no dispatcher support; the per-hop DNS check in
 *     `fetchGuardedRedirects` is the only guard).
 */
export async function webFetch(
	urlStr: string,
	opts: {
		maxBytes?: number;
		signal?: AbortSignal;
		fetchImpl?: typeof fetch;
		resolveHost?: (hostname: string) => Promise<void>;
		/** `raw` skips HTML conversion and main-content extraction. */
		format?: "markdown" | "raw";
		timeoutMs?: number;
		/** Private ranges the user allows (settings `webfetch.allowRanges`). */
		allowRanges?: string[];
		/** Extra request headers for this host (settings `webfetch.hosts`); such fetches are never cached. */
		headers?: Record<string, string>;
		/** Read github.com repos, files, issues and PRs through gh/git instead of their HTML. Off unless given. */
		github?: { allowClone: boolean; run?: GithubRunner };
		/** Read a YouTube video as its details and caption transcript. Off unless given. */
		youtube?: { fetchImpl?: typeof fetch };
	} = {},
): Promise<WebfetchResult> {
	const isBlocked = opts.allowRanges?.length ? blockedExcept(opts.allowRanges) : isPrivateIp;
	const url = assertAllowedUrl(urlStr, isBlocked);
	const cap = Math.min(Math.max(1, Math.floor(opts.maxBytes ?? DEFAULT_MAX_BYTES)), MAX_ALLOWED_BYTES);
	const raw = opts.format === "raw";
	// A page fetched with the user's credentials is theirs alone: keep it out of the shared cache.
	const cacheable = !opts.headers || Object.keys(opts.headers).length === 0;
	const cacheKey = `${cap}|${raw ? "raw" : "md"}|${url.href}`;
	const hit = cacheable ? cacheGet(cacheKey) : undefined;
	if (hit) return hit;
	const timeout = AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS);
	const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
	const fetchImpl = opts.fetchImpl ?? (IS_BUN ? fetch : (undiciFetch as unknown as typeof fetch));
	const agent = IS_BUN ? undefined : makeSafeAgent(isBlocked);
	const resolveHost = opts.resolveHost ?? ((hostname: string) => assertPublicDns(hostname, isBlocked));
	const store = (result: WebfetchResult): WebfetchResult => {
		if (cacheable) cacheSet(cacheKey, result);
		return result;
	};
	const githubTarget = opts.github && !raw ? parseGithubUrl(url) : undefined;
	if (githubTarget && opts.github) {
		const gh = await fetchGithub(githubTarget, { signal, allowClone: opts.github.allowClone, run: opts.github.run });
		if (gh) {
			const inline = inlineOrSpill(gh.text);
			return store({
				url: url.href,
				contentType: "text/markdown",
				bytes: Buffer.byteLength(gh.text),
				truncated: false,
				...inline,
				note: [gh.note, inline.note].filter(Boolean).join("\n") || undefined,
			});
		}
		// gh/git unavailable or the API refused: read the page like any other.
	}
	const videoId = opts.youtube && !raw ? parseYoutubeId(url) : undefined;
	if (videoId) {
		const video = await fetchYoutube(videoId, { fetchImpl: opts.youtube?.fetchImpl, signal });
		if (video) {
			return store({
				url: url.href,
				contentType: "text/markdown",
				bytes: Buffer.byteLength(video),
				truncated: false,
				...inlineOrSpill(video),
			});
		}
		// YouTube did not answer the player API: fall back to the watch page.
	}
	try {
		const baseInit: RequestInit = {
			headers: { "User-Agent": USER_AGENT, Accept: ACCEPT, ...opts.headers },
			signal,
			...(agent ? ({ dispatcher: agent } as unknown as RequestInit) : {}),
		};
		let res: Response;
		try {
			res = await fetchGuardedRedirects(url, baseInit, fetchImpl, resolveHost, isBlocked);
		} catch (err) {
			if (err instanceof CrossHostRedirect) {
				return {
					url: url.href,
					contentType: "",
					bytes: 0,
					truncated: false,
					redirectedTo: err.to,
					text: [
						"REDIRECT DETECTED: the URL redirects to another host, which was not fetched.",
						`Original URL: ${err.from}`,
						`Status: ${err.status}`,
						`Redirects to: ${err.to}`,
						"The target was supplied by the fetched server. If it is plainly where the requested page now lives, fetch it with a new webfetch call; otherwise report the redirect.",
					].join("\n"),
				};
			}
			throw unwrapFetchError(err);
		}
		if (!res.ok) {
			const status = res.statusText ? `${res.status} ${res.statusText}` : `${res.status}`;
			throw new Error(`webfetch: ${status} for ${url.href}`);
		}
		const contentType = res.headers.get("content-type") ?? "";
		const kind = classifyContentType(contentType, url);
		if (kind === "binary") {
			// Don't dump binary; report a short note. Drain the body so the socket frees.
			const size = Number(res.headers.get("content-length") ?? 0);
			await res.body?.cancel().catch(() => {});
			return {
				url: url.href,
				contentType,
				bytes: size,
				truncated: false,
				text: `[webfetch: non-text content ${contentType || "unknown"}${size ? `, ${size} bytes` : ""}]`,
			};
		}
		if (kind === "pdf" || kind === "image") {
			// A document or image cut short cannot be decoded, and both run large: read
			// up to the hard ceiling unless the caller chose a cap.
			const binaryCap = opts.maxBytes === undefined ? MAX_ALLOWED_BYTES : cap;
			const { bytes, truncated } = await readCappedBody(res, binaryCap);
			const base = { url: url.href, contentType, bytes: bytes.length, truncated: false };
			if (truncated) {
				const what = kind === "pdf" ? "PDF" : "image";
				return {
					...base,
					text: `[webfetch: ${what} is larger than ${binaryCap} bytes; pass a larger maxBytes (up to ${MAX_ALLOWED_BYTES}) to read it]`,
				};
			}
			if (kind === "image")
				return { ...base, text: "", image: { bytes, mimeType: contentType.split(";")[0].trim() } };
			let pdfText: string;
			try {
				pdfText = await pdfToText(bytes);
			} catch (err) {
				throw new Error(
					`webfetch: could not read the PDF at ${url.href}: ${err instanceof Error ? err.message : err}`,
				);
			}
			return store({ ...base, ...inlineOrSpill(pdfText) });
		}
		const { bytes, truncated } = await readCappedBody(res, cap);
		const decoded = decodeBody(bytes, contentType);
		let text = kind === "html" && !raw ? await readableMarkdown(decoded) : decoded;
		if (truncated) text += `\n\n[webfetch: output truncated at ${cap} bytes]`;
		const result: WebfetchResult = {
			url: url.href,
			contentType,
			bytes: bytes.length,
			truncated,
			...inlineOrSpill(text),
		};
		return store(result);
	} finally {
		await agent?.destroy().catch(() => {});
	}
}
