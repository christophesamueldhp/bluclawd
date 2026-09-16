import { describe, expect, it } from "vitest";
import { fetchYoutube, parseTimedText, parseYoutubeId } from "../ext/web/youtube.ts";

describe("youtube", () => {
	it("finds the video id in every URL shape", () => {
		const id = "dQw4w9WgXcQ";
		for (const u of [
			`https://www.youtube.com/watch?v=${id}&t=42`,
			`https://m.youtube.com/watch?v=${id}`,
			`https://youtu.be/${id}?si=x`,
			`https://www.youtube.com/shorts/${id}`,
			`https://www.youtube.com/embed/${id}`,
			`https://www.youtube.com/live/${id}`,
			`https://www.youtube-nocookie.com/embed/${id}`,
		]) {
			expect(parseYoutubeId(new URL(u)), u).toBe(id);
		}
		for (const u of [
			"https://www.youtube.com/@channel",
			"https://www.youtube.com/watch?v=short",
			"https://example.com/watch?v=dQw4w9WgXcQ",
		]) {
			expect(parseYoutubeId(new URL(u)), u).toBeUndefined();
		}
	});

	it("turns timed text into timestamped lines", () => {
		const xml = `<timedtext format="3"><body><p t="1360" d="1">[♪♪♪]</p><p t="62640" d="1">We&#39;re no <s>strangers</s>
to love</p><p t="3723000" d="1">&amp; bye</p></body></timedtext>`;
		expect(parseTimedText(xml)).toBe("[0:01] [♪♪♪]\n[1:02] We're no strangers to love\n[1:02:03] & bye");
		expect(parseTimedText(`<transcript><text start="5.2" dur="1">hi &amp;amp; there</text></transcript>`)).toBe(
			"[0:05] hi & there",
		);
	});

	it("renders details and the preferred caption track", async () => {
		const seen: string[] = [];
		const fetchImpl = (async (input: URL | RequestInfo) => {
			const url = String(input);
			seen.push(url);
			if (url.includes("/youtubei/v1/player")) {
				return new Response(
					JSON.stringify({
						playabilityStatus: { status: "OK" },
						videoDetails: {
							title: "T",
							author: "C",
							lengthSeconds: "213",
							viewCount: "1234567",
							shortDescription: "desc",
						},
						captions: {
							playerCaptionsTracklistRenderer: {
								captionTracks: [
									{ baseUrl: "https://www.youtube.com/api/timedtext?asr", languageCode: "en", kind: "asr" },
									{ baseUrl: "https://www.youtube.com/api/timedtext?de", languageCode: "de" },
									{ baseUrl: "https://www.youtube.com/api/timedtext?en", languageCode: "en" },
								],
							},
						},
					}),
				);
			}
			return new Response(`<timedtext><body><p t="0" d="1">hello</p></body></timedtext>`);
		}) as typeof fetch;
		const md = await fetchYoutube("dQw4w9WgXcQ", { fetchImpl });
		expect(seen[1]).toBe("https://www.youtube.com/api/timedtext?en");
		expect(md).toContain("# T");
		expect(md).toContain("Channel: C\nLength: 3:33\nViews: 1,234,567");
		expect(md).toContain("## Transcript (en)\n\n[0:00] hello");
	});

	it("gives up quietly when YouTube does not answer, and never follows a caption URL off youtube.com", async () => {
		expect(
			await fetchYoutube("dQw4w9WgXcQ", {
				fetchImpl: (async () => new Response("no", { status: 400 })) as typeof fetch,
			}),
		).toBeUndefined();
		const seen: string[] = [];
		const fetchImpl = (async (input: URL | RequestInfo) => {
			seen.push(String(input));
			return new Response(
				JSON.stringify({
					videoDetails: { title: "T" },
					captions: {
						playerCaptionsTracklistRenderer: {
							captionTracks: [{ baseUrl: "http://169.254.169.254/x", languageCode: "en" }],
						},
					},
				}),
			);
		}) as typeof fetch;
		const md = await fetchYoutube("dQw4w9WgXcQ", { fetchImpl });
		// Three clients asked (none offered a usable caption URL), and the off-host URL never fetched.
		expect(seen.every((u) => u.includes("/youtubei/v1/player"))).toBe(true);
		expect(md).toContain("(no captions:");
	});
	it("asks the next client when one is refused by the bot check", async () => {
		const clients: string[] = [];
		const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
			if (!String(input).includes("/youtubei/"))
				return new Response(`<timedtext><body><p t="0" d="1">ok</p></body></timedtext>`);
			const name = JSON.parse(String(init?.body)).context.client.clientName as string;
			clients.push(name);
			if (name === "ANDROID")
				return new Response(JSON.stringify({ playabilityStatus: { status: "LOGIN_REQUIRED" } }));
			return new Response(
				JSON.stringify({
					videoDetails: { title: "T" },
					captions: {
						playerCaptionsTracklistRenderer: {
							captionTracks: [{ baseUrl: "https://www.youtube.com/api/timedtext?x", languageCode: "en" }],
						},
					},
				}),
			);
		}) as typeof fetch;
		const md = await fetchYoutube("dQw4w9WgXcQ", { fetchImpl });
		expect(clients).toEqual(["ANDROID", "IOS"]);
		expect(md).toContain("[0:00] ok");
	});
});
