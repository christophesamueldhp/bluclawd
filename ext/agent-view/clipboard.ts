import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ImageContent } from "@earendil-works/pi-ai";
import { piPackageRoot } from "./orchestrator-client.ts";

export interface AgentClipboard {
	image?: ImageContent;
	text?: string;
}

/** Use Pi's platform-aware clipboard readers (native macOS/Windows, Wayland/X11/WSL).
 * They are not public exports, so resolve the shipped utility files from the active Pi,
 * never from a separately installed clipboard library or an obsolete global install. */
export async function readAgentClipboard(): Promise<AgentClipboard> {
	const root =
		piPackageRoot() ??
		process.env.PI_PACKAGE_ROOT ??
		dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
	const imageReader = await import(pathToFileURL(join(root, "dist/utils/clipboard-image.js")).href);
	const image = await imageReader.readClipboardImage();
	if (image)
		return { image: { type: "image", data: Buffer.from(image.bytes).toString("base64"), mimeType: image.mimeType } };
	const textReader = await import(pathToFileURL(join(root, "dist/utils/clipboard.js")).href);
	return { text: (await textReader.readClipboardText()) ?? undefined };
}
