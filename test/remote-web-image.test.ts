import { describe, expect, it } from "vitest";
import { IMAGES_MAX, IMAGE_MAX as SERVER_IMAGE_MAX } from "../daemon/remote/http.ts";
import { ATTEMPTS, fitSize, fits, IMAGE_MAX, isImageFile, keepAsIs } from "../daemon/remote/web/image.js";

describe("a photo made small enough to send", () => {
	it("keeps to the daemon's own limit", () => {
		expect(IMAGE_MAX).toBe(SERVER_IMAGE_MAX);
		expect(IMAGES_MAX).toBe(4);
	});

	it("scales down to fit the long side, keeping its shape, and never up", () => {
		expect(fitSize(4000, 3000, 2048)).toEqual({ width: 2048, height: 1536 });
		expect(fitSize(3000, 4000, 2048)).toEqual({ width: 1536, height: 2048 });
		expect(fitSize(1200, 800, 2048)).toEqual({ width: 1200, height: 800 });
		expect(fitSize(9000, 10, 2048)).toEqual({ width: 2048, height: 2 });
		expect(fitSize(10, 9000, 1024)).toEqual({ width: 1, height: 1024 });
	});

	it("tries 2048 px at quality 0.85 first, then lower qualities and sizes, never higher", () => {
		expect(ATTEMPTS[0]).toEqual({ side: 2048, quality: 0.85 });
		for (const [i, attempt] of ATTEMPTS.entries()) {
			if (i === 0) continue;
			const before = ATTEMPTS[i - 1];
			expect(attempt.side <= before.side, `step ${i}`).toBe(true);
			// Each step makes a smaller file: a lower quality, or a smaller side.
			expect(attempt.side < before.side || attempt.quality < before.quality, `step ${i}`).toBe(true);
		}
	});

	it("fits the daemon's limit by the bytes the base64 decodes to", () => {
		const base64 = (bytes: number) => Buffer.alloc(bytes).toString("base64");
		expect(fits(base64(IMAGE_MAX))).toBe(true);
		expect(fits(base64(IMAGE_MAX - 1))).toBe(true);
		expect(fits(base64(IMAGE_MAX - 2))).toBe(true);
		expect(fits(base64(IMAGE_MAX + 1))).toBe(false);
		expect(fits(base64(3 * 1024 * 1024))).toBe(false);
		expect(fits("")).toBe(true);
	});

	it("sends a PNG as it is only when it is small, needs no scaling and is see-through", () => {
		const png = { type: "image/png", size: 200_000, width: 800, height: 600, alpha: true };
		expect(keepAsIs(png)).toBe(true);
		expect(keepAsIs({ ...png, alpha: false })).toBe(false);
		expect(keepAsIs({ ...png, size: 3_000_000 })).toBe(false);
		expect(keepAsIs({ ...png, width: 3000 })).toBe(false);
		expect(keepAsIs({ ...png, type: "image/jpeg" })).toBe(false);
		expect(keepAsIs({ ...png, type: "image/heic" })).toBe(false);
	});

	it("takes only images: by type, or by name when Files leaves the type out", () => {
		expect(isImageFile({ type: "image/jpeg", name: "IMG_0001.JPG" })).toBe(true);
		expect(isImageFile({ type: "image/heic", name: "IMG_0002.HEIC" })).toBe(true);
		expect(isImageFile({ type: "", name: "IMG_0003.HEIC" })).toBe(true);
		expect(isImageFile({ type: "application/pdf", name: "scan.pdf" })).toBe(false);
		expect(isImageFile({ type: "video/quicktime", name: "IMG_0004.MOV" })).toBe(false);
		expect(isImageFile({ type: "", name: "notes.txt" })).toBe(false);
		// A type that says otherwise wins over the name.
		expect(isImageFile({ type: "text/plain", name: "fake.png" })).toBe(false);
	});
});
