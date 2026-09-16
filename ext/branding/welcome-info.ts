/**
 * The welcome banner's right-hand pane: which model is active, what pi loaded,
 * how large the system prompt starts, the last few sessions in this directory,
 * and the getting-started tips. Anything unknown or empty is left out rather
 * than shown as a zero.
 *
 * Content adapted from pi-powerline-footer's welcome overlay (MIT, Nico Bailon);
 * the counts come from what pi itself loaded, not from scanning directories.
 */
import { formatTokens } from "../statusline/footer.ts";
import type { WelcomeSidebarSection } from "./welcome-box.ts";

export interface WelcomeInfo {
	model: { name: string; provider: string } | undefined;
	loaded: { contextFiles: number; skills: number; tools: number; promptTemplates: number };
	/** chars/4 estimate of the system prompt, when it is known. */
	systemPromptTokens: number | undefined;
	/** Newest first, the current session excluded. */
	recentSessions: ReadonlyArray<{ title: string; modified: Date }>;
	tips: readonly string[];
}

const RECENT_TITLE_WIDTH = 40;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export function formatAge(date: Date, now: number): string {
	const minutes = Math.floor((now - date.getTime()) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${plural(minutes, "minute")} ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${plural(hours, "hour")} ago`;
	return `${plural(Math.floor(hours / 24), "day")} ago`;
}

export function welcomeSections(
	info: WelcomeInfo,
	theme: { fg(color: "dim" | "accent", text: string): string },
	now: number,
): WelcomeSidebarSection[] {
	const dim = (text: string) => theme.fg("dim", text);
	const sections: WelcomeSidebarSection[] = [];

	sections.push({
		heading: "Model",
		lines: [info.model ? `${info.model.name} · ${info.model.provider}` : dim("none selected — /model picks one")],
	});

	const { contextFiles, skills, tools, promptTemplates } = info.loaded;
	const counts = [
		contextFiles > 0 && plural(contextFiles, "context file"),
		skills > 0 && plural(skills, "skill"),
		tools > 0 && plural(tools, "tool"),
		promptTemplates > 0 && plural(promptTemplates, "prompt template"),
	].filter((part): part is string => typeof part === "string");
	const loaded = counts.length > 0 ? [dim(counts.join(" · "))] : [];
	if (info.systemPromptTokens) loaded.push(dim(`~${formatTokens(info.systemPromptTokens)} tokens of system prompt`));
	if (loaded.length > 0) sections.push({ heading: "Loaded", lines: loaded });

	if (info.recentSessions.length > 0) {
		sections.push({
			heading: "Recent sessions",
			lines: info.recentSessions.map((session) => {
				const title = session.title.replace(/\s+/g, " ").trim();
				const clipped = title.length > RECENT_TITLE_WIDTH ? `${title.slice(0, RECENT_TITLE_WIDTH)}…` : title;
				return dim(`${formatAge(session.modified, now)} · ${clipped}`);
			}),
		});
	}

	sections.push({ heading: "Tips for getting started", lines: info.tips.map(dim) });
	return sections;
}
