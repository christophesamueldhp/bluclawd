const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MIN_AUTO_BACKGROUND_MS = 2000;
const NEVER_AUTO_BACKGROUND = ["sleep"];

type Env = NodeJS.ProcessEnv;

function positiveInt(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const n = Number.parseInt(value.trim(), 10);
	return Number.isNaN(n) || n <= 0 ? undefined : n;
}

function truthy(value: string | undefined): boolean {
	return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

export function backgroundTasksDisabled(env: Env = process.env): boolean {
	return truthy(env.BLUCLAWD_DISABLE_BACKGROUND_TASKS);
}

export function defaultTimeoutMs(env: Env = process.env): number {
	return positiveInt(env.BASH_DEFAULT_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
}

export function maxTimeoutMs(env: Env = process.env): number {
	return Math.max(positiveInt(env.BASH_MAX_TIMEOUT_MS) ?? MAX_TIMEOUT_MS, defaultTimeoutMs(env));
}

export function effectiveTimeoutMs(requested: number | undefined, env: Env = process.env): number {
	const asked = typeof requested === "number" && requested > 0 ? requested : defaultTimeoutMs(env);
	return Math.min(asked, maxTimeoutMs(env));
}

function firstWord(command: string): string | undefined {
	return command.trim().split(/[\s;&|]+/)[0] || undefined;
}

export function canAutoBackground(command: string, env: Env = process.env): boolean {
	if (backgroundTasksDisabled(env)) return false;
	const word = firstWord(command);
	return word === undefined || !NEVER_AUTO_BACKGROUND.includes(word);
}

export function autoBackgroundTimeoutMs(
	timeoutMs: number,
	options: { isMain: boolean; canAutoBackground: boolean },
	env: Env = process.env,
): number {
	if (!options.isMain || !options.canAutoBackground) return timeoutMs;
	const early = positiveInt(env.BLUCLAWD_AUTO_BACKGROUND_TIMEOUT_MS);
	return early === undefined ? timeoutMs : Math.min(timeoutMs, Math.max(early, MIN_AUTO_BACKGROUND_MS));
}

export function formatTaskDuration(ms: number): string {
	if (ms < 60_000) {
		if (ms === 0) return "0s";
		if (ms < 1) return `${(ms / 1000).toFixed(1)}s`;
		return `${Math.floor(ms / 1000)}s`;
	}
	let d = Math.floor(ms / 86_400_000);
	let h = Math.floor((ms % 86_400_000) / 3_600_000);
	let m = Math.floor((ms % 3_600_000) / 60_000);
	let s = Math.round((ms % 60_000) / 1000);
	if (s === 60) {
		s = 0;
		m++;
	}
	if (m === 60) {
		m = 0;
		h++;
	}
	if (h === 24) {
		h = 0;
		d++;
	}
	if (d > 0) return `${d}d ${h}h ${m}m`;
	if (h > 0) return `${h}h ${m}m ${s}s`;
	return `${m}m ${s}s`;
}
