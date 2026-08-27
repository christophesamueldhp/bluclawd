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
 *   2. A runtime-dependent DNS guard on the original request AND every redirect
 *      hop:
 *      - Node: a per-request undici dispatcher whose `connect.lookup` validates
 *        the CONNECTED IP (TOCTOU-safe — undici connects to exactly the address
 *        the lookup returned, and re-runs it per hop).
 *      - Bun: the native fetch IGNORES undici's `dispatcher`, so redirects are
 *        followed manually (`fetchGuardedRedirects`) with `assertAllowedUrl` +
 *        an all-addresses DNS validation per hop. Residual TOCTOU: Bun
 *        re-resolves internally, so a DNS answer could change between the check
 *        and the connect — far narrower than no guard, but weaker than Node's
 *        connect-layer path.
 */

import { lookup as dnsLookup } from "node:dns";
import { lookup as dnsLookupAsync } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { APP_NAME, VERSION } from "../../../packages/coding-agent/src/config.ts";
import { htmlToMarkdown } from "./html-to-md.ts";

const USER_AGENT = `${APP_NAME}/${VERSION}`;
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

/**
 * Parse `urlStr` and reject it up front for an unsupported scheme, localhost, or
 * a literal private-IP host. Pure (no DNS). Returns the parsed URL when allowed.
 */
export function assertAllowedUrl(urlStr: string): URL {
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
	if (isIP(bare) && isPrivateIp(bare)) {
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
export function makeValidatingLookup(lookupImpl: DnsLookupAll = dnsLookup as unknown as DnsLookupAll) {
	return (hostname: string, options: { all?: boolean } & Record<string, unknown>, cb: LookupCallback): void => {
		lookupImpl(hostname, { ...options, all: true }, (err, addresses) => {
			if (err) return cb(err, "", 0);
			const list = Array.isArray(addresses) ? addresses : [{ address: String(addresses), family: 4 }];
			if (list.length === 0) return cb(new Error(`no addresses for ${hostname}`), "", 0);
			for (const a of list) {
				if (isPrivateIp(a.address)) {
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
function makeSafeAgent(): Agent {
	return new Agent({
		connect: {
			lookup: makeValidatingLookup() as never,
		},
	});
}

/** Bun's native fetch ignores undici's `dispatcher`, so the connect-layer guard
 * never runs there — those requests must go through `fetchGuardedRedirects`. */
const IS_BUN = typeof process.versions.bun === "string";

/** Max manual redirect hops on the Bun path (undici's own default is 20; tighter
 * is safer for a prompt-injectable tool). */
const MAX_REDIRECTS = 5;

/**
 * Resolve `hostname` and throw if ANY of its addresses is private. Literal IPs
 * pass through (already vetted by `assertAllowedUrl`).
 */
async function assertPublicDns(hostname: string): Promise<void> {
	const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
	if (isIP(bare)) return;
	const addresses = await dnsLookupAsync(bare, { all: true, verbatim: true });
	if (addresses.length === 0) throw new Error(`webfetch: no addresses for ${hostname}`);
	for (const a of addresses) {
		if (isPrivateIp(a.address)) {
			throw new Error(`webfetch: blocked private address ${a.address} for ${hostname}`);
		}
	}
}

/**
 * Bun-path replacement for the dispatcher guard: fetch with redirect:"manual"
 * and follow up to MAX_REDIRECTS hops, running `assertAllowedUrl` (scheme /
 * localhost / literal-IP) plus an all-addresses DNS validation on EVERY hop.
 * Exported for tests (fetchImpl/resolveHost injectable).
 */
export async function fetchGuardedRedirects(
	url: URL,
	init: RequestInit,
	fetchImpl: typeof fetch,
	resolveHost: (hostname: string) => Promise<void> = assertPublicDns,
): Promise<Response> {
	let current = url;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		await resolveHost(current.hostname);
		const res = await fetchImpl(current, { ...init, redirect: "manual" });
		const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
		if (location === null) return res;
		await res.body?.cancel().catch(() => {});
		current = assertAllowedUrl(new URL(location, current).href);
	}
	throw new Error(`webfetch: too many redirects for ${url.href}`);
}

// ── content handling ────────────────────────────────────────────────────────

function classifyContentType(contentType: string): "html" | "text" | "binary" {
	const type = contentType.split(";")[0].trim().toLowerCase();
	if (type === "text/html" || type === "application/xhtml+xml") return "html";
	if (type === "") return "text"; // missing content-type: assume text (best-effort)
	if (type.startsWith("text/")) return "text";
	if (type === "application/json" || type.endsWith("+json")) return "text";
	if (type === "application/xml" || type.endsWith("+xml")) return "text";
	if (type === "application/javascript" || type === "application/ecmascript") return "text";
	return "binary";
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
 * `fetchImpl` is injectable for tests. The default is runtime-dependent:
 *   - Node: the pinned undici package's own fetch — it must share an instance
 *     with `makeSafeAgent`'s Agent, because Node's BUILT-IN fetch given a
 *     foreign-instance dispatcher silently skips response decompression
 *     (content-encoding gets stripped while the body stays compressed).
 *   - Bun: the native fetch (no dispatcher support; `fetchGuardedRedirects`
 *     provides the guard instead).
 */
export async function webFetch(
	urlStr: string,
	opts: {
		maxBytes?: number;
		signal?: AbortSignal;
		fetchImpl?: typeof fetch;
	} = {},
): Promise<WebfetchResult> {
	const url = assertAllowedUrl(urlStr);
	const cap = Math.min(Math.max(1, Math.floor(opts.maxBytes ?? DEFAULT_MAX_BYTES)), MAX_ALLOWED_BYTES);
	const cacheKey = `${cap}|${url.href}`;
	const hit = cacheGet(cacheKey);
	if (hit) return hit;
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
	const fetchImpl = opts.fetchImpl ?? (IS_BUN ? fetch : (undiciFetch as unknown as typeof fetch));
	const agent = IS_BUN ? undefined : makeSafeAgent();
	try {
		const baseInit: RequestInit = {
			headers: { "User-Agent": USER_AGENT },
			signal,
		};
		let res: Response;
		try {
			res = agent
				? await fetchImpl(url, {
						...baseInit,
						dispatcher: agent,
						redirect: "follow",
					} as unknown as RequestInit)
				: await fetchGuardedRedirects(url, baseInit, fetchImpl);
		} catch (err) {
			throw unwrapFetchError(err);
		}
		if (!res.ok) {
			const status = res.statusText ? `${res.status} ${res.statusText}` : `${res.status}`;
			throw new Error(`webfetch: ${status} for ${url.href}`);
		}
		const contentType = res.headers.get("content-type") ?? "";
		const kind = classifyContentType(contentType);
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
		const { bytes, truncated } = await readCappedBody(res, cap);
		const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
		let text = kind === "html" ? htmlToMarkdown(decoded) : decoded;
		if (truncated) text += `\n\n[webfetch: output truncated at ${cap} bytes]`;
		const result: WebfetchResult = {
			url: url.href,
			contentType,
			bytes: bytes.length,
			truncated,
			text,
		};
		cacheSet(cacheKey, result);
		return result;
	} finally {
		await agent?.destroy().catch(() => {});
	}
}
