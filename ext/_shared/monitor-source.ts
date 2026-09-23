/**
 * What a monitor call watches. The tool and the permission layer both decide it
 * here, so they cannot disagree: a call the gate judged as a fetch must be the
 * call that opens a socket, never one that runs a command.
 *
 * Empty strings count as absent: models with strict tool schemas fill every
 * field, sending `ws: { url: "" }` beside a command.
 */

export type MonitorSource =
	| { kind: "command"; command: string }
	| { kind: "ws"; url: string; protocols?: string[] }
	| { kind: "invalid"; reason: string };

export function monitorSource(input: Record<string, unknown>): MonitorSource {
	const command = typeof input.command === "string" && input.command.trim() ? input.command : undefined;
	const ws =
		input.ws && typeof input.ws === "object" ? (input.ws as { url?: unknown; protocols?: unknown }) : undefined;
	const url = typeof ws?.url === "string" && ws.url.trim() ? ws.url.trim() : undefined;
	if (command !== undefined && url !== undefined)
		return { kind: "invalid", reason: "Give monitor exactly one of command or ws." };
	if (command !== undefined) return { kind: "command", command };
	if (url === undefined) return { kind: "invalid", reason: "Give monitor exactly one of command or ws." };
	if (!/^wss?:\/\//i.test(url))
		return { kind: "invalid", reason: `Not a WebSocket URL: ${url} (use ws:// or wss://)` };
	const protocols = Array.isArray(ws?.protocols) ? ws.protocols.filter((p): p is string => typeof p === "string") : [];
	return { kind: "ws", url, protocols: protocols.length > 0 ? protocols : undefined };
}
