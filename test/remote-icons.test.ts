import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import photon from "@silvia-odwyer/photon-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RemoteServer, startRemoteServer } from "../daemon/remote/http.ts";
import { RemoteStore } from "../daemon/remote/pairing.ts";
import { BODY_COLOR, EYE_COLOR } from "../ext/_shared/mascot.ts";
import { ICONS, renderIcon, WEB_DIR } from "../scripts/pwa-icons.ts";

function decode(bytes: Buffer): { width: number; height: number; pixels: Uint8Array } {
	const image = photon.PhotonImage.new_from_byteslice(bytes);
	try {
		return { width: image.get_width(), height: image.get_height(), pixels: image.get_raw_pixels() };
	} finally {
		image.free();
	}
}

function colorAt(image: { width: number; pixels: Uint8Array }, x: number, y: number): string {
	const at = (y * image.width + x) * 4;
	return `#${[...image.pixels.slice(at, at + 3)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

describe("PWA icons", () => {
	it.each(Object.entries(ICONS))("%s is what scripts/pwa-icons.ts draws", (name, size) => {
		const committed = decode(readFileSync(join(WEB_DIR, name)));
		expect([committed.width, committed.height]).toEqual([size, size]);
		expect(committed.pixels).toEqual(decode(renderIcon(size)).pixels);
	});

	it("draws the mascot centred on white, a whole pixel square per grid block", () => {
		const icon = decode(renderIcon(180));
		// 6 px blocks: the 20×15 grid is 120×90, from (30, 45).
		expect(colorAt(icon, 0, 0)).toBe("#ffffff");
		expect(colorAt(icon, 179, 179)).toBe("#ffffff");
		// Row 4, column 5: the left eye's top-left pixel and block.
		expect(colorAt(icon, 30 + 5 * 6, 45 + 4 * 6)).toBe(EYE_COLOR);
		expect(colorAt(icon, 30 + 5 * 6 - 1, 45 + 4 * 6)).toBe(BODY_COLOR);
		// The head's top row (columns 8–11), and the gap left of it.
		expect(colorAt(icon, 30 + 8 * 6, 45)).toBe(BODY_COLOR);
		expect(colorAt(icon, 30 + 8 * 6 - 1, 45)).toBe("#ffffff");
		expect(colorAt(icon, 30 + 8 * 6, 44)).toBe("#ffffff");
	});

	it("is linked from the page, the manifest and the offline shell", () => {
		const html = readFileSync(join(WEB_DIR, "index.html"), "utf8");
		expect(html).toContain('<link rel="apple-touch-icon" href="apple-touch-icon.png">');
		expect(html).toContain('href="favicon-32.png"');
		const manifest = JSON.parse(readFileSync(join(WEB_DIR, "manifest.webmanifest"), "utf8")) as {
			icons: Array<{ src: string; sizes: string; type: string }>;
		};
		for (const icon of manifest.icons) {
			expect(icon.sizes).toBe(`${ICONS[icon.src]}x${ICONS[icon.src]}`);
			expect(icon.type).toBe("image/png");
		}
		const sw = readFileSync(join(WEB_DIR, "sw.js"), "utf8");
		for (const name of Object.keys(ICONS)) expect(sw).toContain(`"/${name}"`);
	});

	describe("served", () => {
		let dir: string;
		let server: RemoteServer;
		beforeAll(async () => {
			dir = mkdtempSync(join(tmpdir(), "bluclawd-icons-"));
			server = await startRemoteServer(
				{
					store: new RemoteStore(join(dir, "remote.json")),
					webDir: WEB_DIR,
					listInstances: () => [],
					send: () => false,
					launch: () => undefined,
					startSession: () => "",
					resuming: () => false,
					report: () => undefined,
					tmux: { screen: () => [], sendKeys: () => {}, sendText: () => {} },
				},
				0,
			);
		});
		afterAll(async () => {
			await server.close();
			rmSync(dir, { recursive: true, force: true });
		});

		it.each(Object.keys(ICONS))("%s as image/png", async (name) => {
			const res = await fetch(`http://127.0.0.1:${server.port}/${name}`);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("image/png");
			expect(Buffer.from(await res.arrayBuffer())).toEqual(readFileSync(join(WEB_DIR, name)));
		});
	});
});
