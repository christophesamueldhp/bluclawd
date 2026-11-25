// @ts-check

export const ATTACH_MAX = 4;
export const IMAGE_MAX = 2 * 1024 * 1024;
const BASE64_MAX = Math.ceil(IMAGE_MAX / 3) * 4;
export const ATTEMPTS = [
	{ side: 2048, quality: 0.85 },
	{ side: 2048, quality: 0.75 },
	{ side: 2048, quality: 0.65 },
	{ side: 1600, quality: 0.7 },
	{ side: 1280, quality: 0.65 },
	{ side: 1024, quality: 0.6 },
];
export const KEEP_PNG_MAX = 1024 * 1024;
const THUMB_SIDE = 160;
/** What a file without a type is taken for an image by, since Files can leave a photo's type out. */
const IMAGE_NAME = /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?)$/i;

/** @param {{ type: string, name: string }} file */
export function isImageFile(file) {
	return file.type ? file.type.startsWith("image/") : IMAGE_NAME.test(file.name);
}

/** @param {number} width @param {number} height @param {number} side */
export function fitSize(width, height, side) {
	const scale = Math.min(1, side / Math.max(width, height));
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** @param {string} base64 */
export function fits(base64) {
	const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
	return base64.length <= BASE64_MAX && (base64.length / 4) * 3 - padding <= IMAGE_MAX;
}

/** @param {{ type: string, size: number, width: number, height: number, alpha: boolean }} image */
export function keepAsIs({ type, size, width, height, alpha }) {
	return type === "image/png" && size <= KEEP_PNG_MAX && Math.max(width, height) <= ATTEMPTS[0].side && alpha;
}

/** @typedef {{ mimeType: string, data: string, thumb: string }} Attachment */
/** @typedef {{ source: HTMLImageElement | ImageBitmap, width: number, height: number }} Decoded */

/** @param {File} file @returns {Promise<Attachment>} */
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
		if ("close" in image.source) image.source.close();
	}
}

/**
 * An <img> first, because Safari reads HEIC into one, and every browser turns it upright by its EXIF
 * orientation, on the page and on a canvas.
 * @param {File} file @returns {Promise<Decoded>}
 */
async function decode(file) {
	const decoded = await decodeInImgUnderCsp(file);
	if (decoded) return decoded;
	const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
	return { source: bitmap, width: bitmap.width, height: bitmap.height };
}

/** @param {File} file @returns {Promise<Decoded | undefined>} */
async function decodeInImgUnderCsp(file) {
	try {
		const img = new Image();
		img.src = await dataUrl(file);
		await img.decode();
		if (img.naturalWidth && img.naturalHeight)
			return { source: img, width: img.naturalWidth, height: img.naturalHeight };
	} catch {}
	return undefined;
}

/** @param {number} width @param {number} height */
function canvas(width, height) {
	const element = document.createElement("canvas");
	element.width = width;
	element.height = height;
	return { element, context: /** @type {CanvasRenderingContext2D} */ (element.getContext("2d")) };
}

/** @param {Decoded} image */
function hasAlpha(image) {
	const size = fitSize(image.width, image.height, 256);
	const { context } = canvas(size.width, size.height);
	context.drawImage(image.source, 0, 0, size.width, size.height);
	const pixels = context.getImageData(0, 0, size.width, size.height).data;
	for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 255) return true;
	return false;
}

/** @param {Decoded} image @param {number} side @param {number} quality */
function jpeg(image, side, quality) {
	const size = fitSize(image.width, image.height, side);
	const { element, context } = canvas(size.width, size.height);
	// A JPEG has no transparency, so what was see-through turns white, not black.
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
