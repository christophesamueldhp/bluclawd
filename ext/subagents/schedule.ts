/**
 * `task_schedule`: start a subagent task later, once or on a repeat
 * (pi-subagents' schedules; Claude Code's session-scoped cron).
 *
 * Session-scoped by design: a due task starts as a background run of THIS
 * session and reports through the same completion message, which needs this
 * session alive to receive it. Schedules end with the session. Durable,
 * cross-session schedules belong to the fleet daemon, which outlives sessions.
 *
 * Permission: creating a schedule is judged as the `task` call it will make
 * (evaluate.ts), so the Task rules and the mode apply when the user is there to
 * answer — not later, when the timer fires.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ScheduleParams = Type.Object({
	action: StringEnum(["create", "list", "cancel"] as const, {
		description: "create a schedule, list them, or cancel one",
	}),
	id: Type.Optional(Type.String({ description: "cancel: the sch-N id" })),
	in: Type.Optional(Type.String({ description: 'create: run once after this long, e.g. "30s", "10m", "2h"' })),
	every: Type.Optional(Type.String({ description: 'create: run repeatedly at this interval (at least "1m")' })),
	agent: Type.Optional(Type.String({ description: "create: the agent to run" })),
	task: Type.Optional(Type.String({ description: "create: the task for that agent" })),
	workflow: Type.Optional(Type.String({ description: "create: a saved workflow to run instead of agent/task" })),
	input: Type.Optional(Type.String({ description: "create: the workflow's input" })),
	mission: Type.Optional(Type.String({ description: "create: mission label for the runs" })),
	gate: Type.Optional(Type.String({ description: "create: acceptance gate command" })),
});

/** The task call a schedule makes when it is due. */
export interface ScheduledCall {
	agent?: string;
	task?: string;
	workflow?: string;
	input?: string;
	mission?: string;
	gate?: string;
}

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const MIN_EVERY_MS = 60_000;

export function parseDuration(raw: string | undefined): number | undefined {
	const match = /^\s*(\d+)\s*([smhd])\s*$/.exec(raw ?? "");
	return match ? Number(match[1]) * UNITS[match[2]] : undefined;
}

interface Schedule {
	id: string;
	call: ScheduledCall;
	everyMs?: number;
	nextAt: number;
	timer: ReturnType<typeof setTimeout>;
}

const reply = (text: string): AgentToolResult<undefined> => ({ content: [{ type: "text", text }], details: undefined });
const describe = (call: ScheduledCall): string =>
	call.workflow ? `workflow ${call.workflow}: ${call.input ?? ""}` : `${call.agent}: ${call.task}`;

export function createScheduleTool(start: (call: ScheduledCall, ctx: ExtensionContext) => Promise<void>): {
	tool: ToolDefinition<typeof ScheduleParams, undefined>;
	clear: () => void;
} {
	const schedules = new Map<string, Schedule>();
	let counter = 0;

	const arm = (schedule: Schedule, delay: number, ctx: ExtensionContext): void => {
		schedule.nextAt = Date.now() + delay;
		schedule.timer = setTimeout(() => {
			if (schedule.everyMs) arm(schedule, schedule.everyMs, ctx);
			else schedules.delete(schedule.id);
			void start(schedule.call, ctx).catch(() => undefined);
		}, delay);
	};

	const tool: ToolDefinition<typeof ScheduleParams, undefined> = {
		name: "task_schedule",
		label: "Task Schedule",
		description:
			"Schedule a subagent task (agent + task, or a saved workflow) to start later — once (in) or repeatedly (every) — as a background run whose result arrives as a message. Schedules last until cancelled or the session ends.",
		parameters: ScheduleParams,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			if (params.action === "list") {
				if (schedules.size === 0) return reply("No schedules.");
				return reply(
					Array.from(schedules.values())
						.map(
							(s) =>
								`${s.id} · ${s.everyMs ? `every ${s.everyMs / 60_000}m` : "once"} · next ${new Date(s.nextAt).toISOString()} · ${describe(s.call)}`,
						)
						.join("\n"),
				);
			}
			if (params.action === "cancel") {
				const schedule = params.id ? schedules.get(params.id) : undefined;
				if (!schedule) return reply(`No schedule "${params.id ?? ""}".`);
				clearTimeout(schedule.timer);
				schedules.delete(schedule.id);
				return reply(`Cancelled ${schedule.id}.`);
			}

			const once = params.in ? parseDuration(params.in) : undefined;
			const everyMs = params.every ? parseDuration(params.every) : undefined;
			if ((once === undefined) === (everyMs === undefined)) {
				return reply('Give exactly one of in or every, as a number and a unit: "30s", "10m", "2h", "1d".');
			}
			if (everyMs !== undefined && everyMs < MIN_EVERY_MS) return reply("every must be at least 1m.");
			const call: ScheduledCall = {
				agent: params.agent || undefined,
				task: params.task || undefined,
				workflow: params.workflow || undefined,
				input: params.input || undefined,
				mission: params.mission || undefined,
				gate: params.gate || undefined,
			};
			if (!call.workflow && !(call.agent && call.task?.trim())) {
				return reply("Give agent and task, or a workflow.");
			}
			const schedule: Schedule = { id: `sch-${++counter}`, call, everyMs, nextAt: 0, timer: undefined as never };
			schedules.set(schedule.id, schedule);
			arm(schedule, once ?? (everyMs as number), ctx);
			return reply(
				`Scheduled ${schedule.id}: ${describe(call)} — ${everyMs ? `every ${params.every}` : `in ${params.in}`}. Each run starts in the background and reports when done.`,
			);
		},
	};

	const clear = () => {
		for (const s of schedules.values()) clearTimeout(s.timer);
		schedules.clear();
	};
	return { tool, clear };
}
