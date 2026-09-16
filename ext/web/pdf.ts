/** PDF text extraction for `webfetch`, via unpdf (a serverless build of Mozilla pdf.js). */

/** Pages extracted at most; a longer document says where it stopped. */
const MAX_PAGES = 100;

export async function pdfToText(bytes: Uint8Array): Promise<string> {
	// Loaded on first use: pdf.js is several megabytes of JavaScript.
	const { extractText, getDocumentProxy } = await import("unpdf");
	const pdf = await getDocumentProxy(bytes);
	const { totalPages, text } = await extractText(pdf, { mergePages: false });
	const pages = text.slice(0, MAX_PAGES).map((page, i) => `<!-- page ${i + 1} -->\n${page.trim()}`);
	if (totalPages > MAX_PAGES) pages.push(`[webfetch: PDF has ${totalPages} pages; extracted the first ${MAX_PAGES}]`);
	return pages.join("\n\n");
}
