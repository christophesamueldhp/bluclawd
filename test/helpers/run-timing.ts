import { existsSync, readFileSync } from "node:fs";
import { readinessMs } from "./heartbeats.ts";
import type { RealPi } from "./real-pi.ts";

export const piStartsTimeout = (pis: number) => (pis + 1) * readinessMs;

export const nothingWithin = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const whicheverStarted = (real: Pick<RealPi, "requests">, names: string[]) =>
	names.filter((name) => real.requests(name).length > 0);

export async function awaitFixtureExpiry(heartbeatPath: string): Promise<void> {
	if (!existsSync(`${heartbeatPath}.identity`)) return;
	const info = JSON.parse(readFileSync(`${heartbeatPath}.identity`, "utf8"));
	await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, info.expiresAt - Date.now()) + 100));
}
