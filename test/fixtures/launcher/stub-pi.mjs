import { writeSync } from "node:fs";

export * from "@earendil-works/pi-coding-agent";

export async function main(argv) {
	writeSync(1, JSON.stringify(argv));
	process.exit(0);
}
