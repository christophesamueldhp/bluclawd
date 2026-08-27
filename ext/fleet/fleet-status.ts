import type { ThemeColor } from "../../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

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

export function relativeTime(iso: string | undefined, nowMs: number): string {
	if (!iso) return "";
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return "";
	const seconds = Math.max(0, Math.floor((nowMs - then) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

export function groupByCwd<T extends { cwd: string }>(instances: T[]): Array<{ cwd: string; items: T[] }> {
	const groups: Array<{ cwd: string; items: T[] }> = [];
	const index = new Map<string, T[]>();
	for (const inst of instances) {
		let items = index.get(inst.cwd);
		if (!items) {
			items = [];
			index.set(inst.cwd, items);
			groups.push({ cwd: inst.cwd, items });
		}
		items.push(inst);
	}
	return groups;
}
