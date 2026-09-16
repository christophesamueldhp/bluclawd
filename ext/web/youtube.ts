/**
 * YouTube videos for `webfetch`: title, channel, length, description and the
 * caption transcript with timestamps, as text any model can read. No video
 * model is involved (pi-web-access sends videos to Gemini; that would tie the
 * feature to one provider).
 *
 * The watch page's caption URLs now come back empty without a proof-of-origin
 * token, so this asks YouTube's player API as its mobile apps do, whose caption
 * URLs still answer. That is an undocumented interface: when it stops
 * answering, the caller falls back to fetching the watch page.
 */

import { USER_AGENT } from "./search.ts";

const PLAYER_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";

/**
 * Player clients asked in turn. YouTube's bot check answers each differently per
 * video and per hour, so one that returns no captions is not the last word.
 */
const CLIENTS = [
	{
		userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 14)",
		client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 34 },
	},
	{
		userAgent: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
		client: {
			clientName: "IOS",
			clientVersion: "20.10.4",
			deviceMake: "Apple",
			deviceModel: "iPhone16,2",
			osName: "iPhone",
			osVersion: "18.3.2.22D82",
		},
	},
	{
		userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
		client: { clientName: "MWEB", clientVersion: "2.20250101.00.00" },
	},
];
const TIMEOUT_MS = 20_000;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** The video id of a youtube.com / youtu.be video URL, or undefined. */
export function parseYoutubeId(url: URL): string | undefined {
	const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
	let id: string | undefined;
	if (host === "youtu.be") id = url.pathname.split("/")[1];
	else if (host === "youtube.com" || host === "youtube-nocookie.com") {
		if (url.pathname === "/watch") id = url.searchParams.get("v") ?? undefined;
		else {
			const m = /^\/(?:shorts|embed|live|v)\/([^/]+)/.exec(url.pathname);
			id = m?.[1];
		}
	}
	return id && VIDEO_ID.test(id) ? id : undefined;
}

interface CaptionTrack {
	baseUrl?: string;
	languageCode?: string;
	kind?: string;
	name?: { runs?: Array<{ text?: string }>; simpleText?: string };
}

/** Manual captions before auto-generated ones; the preferred language first. */
function pickTrack(tracks: CaptionTrack[], lang: string): CaptionTrack | undefined {
	const rank = (t: CaptionTrack) =>
		(t.kind === "asr" ? 2 : 0) + (t.languageCode?.toLowerCase().startsWith(lang) ? 0 : 1);
	return [...tracks].filter((t) => t.baseUrl).sort((a, b) => rank(a) - rank(b))[0];
}

function decodeXmlText(text: string): string {
	return text
		.replace(/<[^>]*>/g, "")
		.replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

function timestamp(ms: number): string {
	const total = Math.floor(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = String(total % 60).padStart(2, "0");
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Timed-text XML (format 3 `<p t=… d=…>`, or legacy `<text start=…>`) as `[m:ss] line` lines. */
export function parseTimedText(xml: string): string {
	const lines: string[] = [];
	for (const m of xml.matchAll(/<p\b[^>]*\bt="(\d+)"[^>]*>([\s\S]*?)<\/p>/g)) {
		const text = decodeXmlText(m[2]).replace(/\s+/g, " ").trim();
		if (text) lines.push(`[${timestamp(Number(m[1]))}] ${text}`);
	}
	if (lines.length === 0) {
		for (const m of xml.matchAll(/<text\b[^>]*\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g)) {
			const text = decodeXmlText(decodeXmlText(m[2])).replace(/\s+/g, " ").trim();
			if (text) lines.push(`[${timestamp(Number(m[1]) * 1000)}] ${text}`);
		}
	}
	return lines.join("\n");
}

interface PlayerResponse {
	playabilityStatus?: { status?: string; reason?: string };
	videoDetails?: {
		title?: string;
		author?: string;
		lengthSeconds?: string;
		viewCount?: string;
		shortDescription?: string;
	};
	captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
}

/** Markdown for the video, or undefined when YouTube did not answer usefully. Throws only on abort. */
export async function fetchYoutube(
	id: string,
	opts: { fetchImpl?: typeof fetch; signal?: AbortSignal; lang?: string } = {},
): Promise<string | undefined> {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
	const lang = (opts.lang ?? "en").toLowerCase();
	try {
		let data: PlayerResponse | undefined;
		for (const { userAgent, client } of CLIENTS) {
			const res = await fetchImpl(PLAYER_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json", "User-Agent": `${userAgent} ${USER_AGENT}` },
				body: JSON.stringify({ context: { client: { ...client, hl: lang } }, videoId: id }),
				signal,
				redirect: "manual",
			});
			if (!res.ok) continue;
			const answer = (await res.json()) as PlayerResponse;
			if (!answer.videoDetails?.title) {
				data ??= answer;
				continue;
			}
			if (!data?.videoDetails?.title) data = answer;
			if (answer.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length) {
				data = answer;
				break;
			}
		}
		const details = data?.videoDetails;
		if (!data || !details?.title) return undefined;

		let transcript = "";
		let trackLabel = "";
		const track = pickTrack(data.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [], lang);
		// Only follow a caption URL on YouTube's own host.
		if (track?.baseUrl && new URL(track.baseUrl).hostname === "www.youtube.com") {
			const captions = await fetchImpl(track.baseUrl, { signal, redirect: "manual" });
			if (captions.ok) transcript = parseTimedText(await captions.text());
			trackLabel = `${track.languageCode ?? "?"}${track.kind === "asr" ? ", auto-generated" : ""}`;
		}

		const length = Number(details.lengthSeconds);
		const meta = [
			details.author && `Channel: ${details.author}`,
			Number.isFinite(length) && length > 0 && `Length: ${timestamp(length * 1000)}`,
			details.viewCount && `Views: ${Number(details.viewCount).toLocaleString("en-US")}`,
			data.playabilityStatus?.status && data.playabilityStatus.status !== "OK"
				? `Playability: ${data.playabilityStatus.status}${data.playabilityStatus.reason ? ` (${data.playabilityStatus.reason})` : ""}`
				: "",
		].filter(Boolean);
		const sections = [
			`# ${details.title}`,
			`https://www.youtube.com/watch?v=${id}`,
			meta.join("\n"),
			details.shortDescription ? `## Description\n\n${details.shortDescription.trim()}` : "",
			transcript
				? `## Transcript (${trackLabel})\n\n${transcript}`
				: "## Transcript\n\n(no captions: the video has none, or YouTube withheld them from an anonymous client)",
		];
		return sections.filter(Boolean).join("\n\n");
	} catch (err) {
		if (opts.signal?.aborted) throw err;
		return undefined;
	}
}
