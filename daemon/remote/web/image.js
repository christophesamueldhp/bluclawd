// @ts-check
/**
 * A photo picked on the phone, made into what the daemon takes with a prompt: at most IMAGE_MAX
 * bytes each, as a JPEG unless a small PNG's transparency is worth keeping. It is decoded here, so
 * an iPhone's HEIC goes too: Safari reads it into an <img>. The size and quality steps are pure,
 * so the tests import them.
 */

/** The daemon's limit on each image (daemon/remote/http.ts), on its bytes and on its base64. */
export const IMAGE_MAX = 2 * 1024 * 1024;
const BASE64_MAX = Math.ceil(IMAGE_MAX / 3) * 4;
/** A photo's long side and JPEG quality, then smaller and lower ones while it is still too large. */
export const ATTEMPTS = [
	{ side: 2048, quality: 0.85 },
	{ side: 2048, quality: 0.75 },
	{ side: 2048, quality: 0.65 },
	{ side: 1600, quality: 0.7 },
	{ side: 1280, quality: 0.65 },
	{ side: 1024, quality: 0.6 },
];
/** A PNG this small, with see-through pixels and no longer than ATTEMPTS[0]'s side, goes as it is. */
export const KEEP_PNG_MAX = 1024 * 1024;
const THUMB_SIDE = 160;
/** What a file without a type is taken for an image by: Files can leave a photo's type out. */
const IMAGE_NAME = /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?)$/i;

/** @param {{ type: string, name: string }} file */
export function isImageFile(file) {
	return file.type ? file.type.startsWith("image/") : IMAGE_NAME.test(file.name);
}

/**
 * `width` × `height` scaled down to fit `side` on its long side, never up; whole pixels.
 * @param {number} width @param {number} height @param {number} side
 */
export function fitSize(width, height, side) {
	const scale = Math.min(1, side / Math.max(width, height));
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Whether this base64 is within the daemon's limit: its length, and the bytes it decodes to. @param {string} base64 */
export function fits(base64) {
	const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
	return base64.length <= BASE64_MAX && (base64.length / 4) * 3 - padding <= IMAGE_MAX;
}

/**
 * A PNG goes as it is only when it is small, needs no scaling, and has see-through pixels, which a
 * JPEG would turn white; anything else is re-encoded.
 * @param {{ type: string, size: number, width: number, height: number, alpha: boolean }} image
 */
export function keepAsIs({ type, size, width, height, alpha }) {
	return type === "image/png" && size <= KEEP_PNG_MAX && Math.max(width, height) <= ATTEMPTS[0].side && alpha;
}

/** @typedef {{ mimeType: string, data: string, thumb: string }} Attachment base64 `data`, a data URL `thumb` */
/** @typedef {{ source: HTMLImageElement | ImageBitmap, width: number, height: number }} Decoded */

/**
 * The picked file, decoded and scaled down, as a prompt sends it. Throws when it cannot be read,
 * or not made small enough (`image_too_large`).
 * @param {File} file @returns {Promise<Attachment>}
 */
export async function readImage(file) {
	const image = await decode(file);
	try {
		const { width, height } = image;
		const alpha = file.type === "image/png" && file.size <= KEEP_PNG_MAX && hasAlpha(image);
		const thumb = jpeg(image, THUMB_SIDE, 0.8);
		if (keepAsIs({ type: file.type, size: file.size, width, height, alpha })) {
			const url = await dataUrl(file);
			return { mimeType: "image/png", data: url.slice(url.indexOf(",") + 1), thumb };
		}
		for (const { side, quality } of ATTEMPTS) {
			const url = jpeg(image, side, quality);
			const data = url.slice(url.indexOf(",") + 1);
			if (url.startsWith("data:image/jpeg") && fits(data)) return { mimeType: "image/jpeg", data, thumb };
		}
		throw new Error("image_too_large");
	} finally {
		// An <img> has nothing to close; a browser without ImageBitmap never made one.
		if ("close" in image.source) image.source.close();
	}
}

/**
 * An <img> first: Safari reads HEIC into one, and every browser turns it upright by its EXIF
 * orientation, on the page and on a canvas. From a data URL: the CSP allows no blob: one.
 * @param {File} file @returns {Promise<Decoded>}
 */
async function decode(file) {
	try {
		const img = new Image();
		img.src = await dataUrl(file);
		await img.decode();
		if (img.naturalWidth && img.naturalHeight)
			return { source: img, width: img.naturalWidth, height: img.naturalHeight };
	} catch {
		// tried another way below
	}
	const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
	return { source: bitmap, width: bitmap.width, height: bitmap.height };
}

/** @param {number} width @param {number} height */
function canvas(width, height) {
	const element = document.createElement("canvas");
	element.width = width;
	element.height = height;
	return { element, context: /** @type {CanvasRenderingContext2D} */ (element.getContext("2d")) };
}

/** Whether any pixel is see-through, looked for at a small size. @param {Decoded} image */
function hasAlpha(image) {
	const size = fitSize(image.width, image.height, 256);
	const { context } = canvas(size.width, size.height);
	context.drawImage(image.source, 0, 0, size.width, size.height);
	const pixels = context.getImageData(0, 0, size.width, size.height).data;
	for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 255) return true;
	return false;
}

/**
 * The image scaled to fit `side` on its long side, as a JPEG data URL.
 * @param {Decoded} image @param {number} side @param {number} quality
 */
function jpeg(image, side, quality) {
	const size = fitSize(image.width, image.height, side);
	const { element, context } = canvas(size.width, size.height);
	// A JPEG has no transparency: what was see-through turns white, not black.
	context.fillStyle = "#fff";
	context.fillRect(0, 0, size.width, size.height);
	context.imageSmoothingQuality = "high";
	context.drawImage(image.source, 0, 0, size.width, size.height);
	return element.toDataURL("image/jpeg", quality);
}

/** @param {Blob} blob @returns {Promise<string>} */
export function dataUrl(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
}
