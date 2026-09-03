import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export type AgentActivity = "idle" | "working" | "awaiting_input";
export type InstanceStatus = "starting" | "online" | "stopping" | "stopped" | "error";

export interface StatusDisplay {
	label: string;
	color: ThemeColor;
}

export function describeStatus(inst: { status: InstanceStatus; activity?: AgentActivity }): StatusDisplay {
	if (inst.status === "online") {
		if (inst.activity === "working") return { label: "Working", color: "accent" };
		if (inst.activity === "awaiting_input") return { label: "Needs input", color: "warning" };
		return { label: "Idle", color: "muted" };
	}
	switch (inst.status) {
		case "stopped":
			return { label: "Done", color: "success" };
		case "error":
			return { label: "Error", color: "error" };
		case "starting":
			return { label: "Starting", color: "dim" };
		case "stopping":
			return { label: "Stopping", color: "dim" };
	}
}

export interface FleetCounts {
	needsInput: number;
	working: number;
	done: number;
}

export function countStatuses(instances: Array<{ status: InstanceStatus; activity?: AgentActivity }>): FleetCounts {
	const counts: FleetCounts = { needsInput: 0, working: 0, done: 0 };
	for (const inst of instances) {
		if (inst.status === "online" && inst.activity === "awaiting_input") counts.needsInput++;
		else if (inst.status === "online" && inst.activity === "working") counts.working++;
		// Only a genuinely stopped session is "Done" (matches describeStatus). online-idle, starting,
		// stopping and error are none of the three headline states and must not inflate the done count.
		else if (inst.status === "stopped") counts.done++;
	}
	return counts;
}

/** Claude Code's narrow relative format: `5m ago`, `3h ago`, `2d ago`. */
export function relativeTime(iso: string | undefined, nowMs: number): string {
	if (!iso) return "";
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return "";
	const seconds = Math.max(0, Math.floor((nowMs - then) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/** Live rows first (needs input, working, idle), then everything else by most recent activity —
 *  surfacing what is running is the roster's job, so this is NOT pure modified-desc like /resume. */
export function sortForRoster<
	T extends { status: InstanceStatus; activity?: AgentActivity; lastSeenAt?: string; createdAt?: string },
>(instances: T[]): T[] {
	const rank = (i: T): number => {
		if (i.status !== "online") return 3;
		if (i.activity === "awaiting_input") return 0;
		if (i.activity === "working") return 1;
		return 2;
	};
	const stamp = (i: T): number => Date.parse(i.lastSeenAt ?? i.createdAt ?? "") || 0;
	return [...instances].sort((a, b) => rank(a) - rank(b) || stamp(b) - stamp(a));
}

/** Case-insensitive substring match over the fields /resume searches: title, path, branch. */
export function matchesQuery(fields: Array<string | undefined>, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	return fields.some((f) => f?.toLowerCase().includes(q));
}
