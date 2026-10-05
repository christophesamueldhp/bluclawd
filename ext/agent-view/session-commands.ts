import type { RpcCommand } from "@earendil-works/pi-coding-agent";
import type { SessionController } from "./session-controller.ts";
export type LocalSessionAction =
	| "agents"
	| "new"
	| "resume"
	| "model"
	| "theme"
	| "help"
	| "settings"
	| "quit"
	| "reload";
export type SessionCommandRoute =
	| { type: "prompt"; message: string }
	| { type: "rpc"; command: RpcCommand }
	| { type: "local"; action: LocalSessionAction }
	| { type: "unavailable"; message: string };
export interface SessionCommandContext {
	busy: boolean;
	commands: Array<{
		name: string;
		source: "extension" | "prompt" | "skill";
	}> /** A separate explicit audit, never inferred from discovery. */;
	rpcCompatibleExtensions?: ReadonlyArray<string>;
}
const local: Record<string, LocalSessionAction> = {
	"agent-view": "agents",
	agents: "agents",
	new: "new",
	resume: "resume",
	theme: "theme",
	help: "help",
	settings: "settings",
	quit: "quit",
	reload: "reload",
};
const unavailable = (message: string): SessionCommandRoute => ({ type: "unavailable", message });
export function routeSessionCommand(text: string, context: SessionCommandContext): SessionCommandRoute {
	const input = text.trim();
	if (input.startsWith("!")) {
		const excluded = input.startsWith("!!");
		const command = input.slice(excluded ? 2 : 1).trim();
		return command
			? { type: "rpc", command: { type: "bash", command, excludeFromContext: excluded } }
			: unavailable("Enter a bash command after !");
	}
	if (!input.startsWith("/")) return { type: "prompt", message: text };
	const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(input);
	if (!match) return unavailable("Enter a command name after /");
	const name = match[1];
	const args = (match[2] ?? "").trim();
	if (Object.hasOwn(local, name)) return { type: "local", action: local[name] };
	if (["tasks", "bashes", "rewind"].includes(name))
		return unavailable(
			`/${name}: interactive screen unavailable in managed conversations. Its model-callable tools remain available.`,
		);
	if (["fork", "clone", "tree"].includes(name))
		return unavailable(
			context.busy
				? "Wait until the selected session is idle before branching"
				: "Native branch navigation is unavailable in managed conversations",
		);
	switch (name) {
		case "model": {
			if (!args) return { type: "local", action: "model" };
			if (args === "cycle") return { type: "rpc", command: { type: "cycle_model" } };
			const slash = args.indexOf("/");
			if (slash <= 0 || slash === args.length - 1 || /\s/.test(args))
				return unavailable("Use /model for the selected-child model picker, or /model provider/model-id");
			return {
				type: "rpc",
				command: { type: "set_model", provider: args.slice(0, slash), modelId: args.slice(slash + 1) },
			};
		}
		case "thinking": {
			if (!args) return { type: "rpc", command: { type: "cycle_thinking_level" } };
			const level = args as Extract<RpcCommand, { type: "set_thinking_level" }>["level"];
			if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level))
				return unavailable("Thinking level must be off, minimal, low, medium, high, xhigh, or max");
			return { type: "rpc", command: { type: "set_thinking_level", level } };
		}
		case "compact":
			return context.busy
				? unavailable("Wait until the selected session is idle before compaction")
				: { type: "rpc", command: { type: "compact", ...(args ? { customInstructions: args } : {}) } };
		case "name":
			return args
				? { type: "rpc", command: { type: "set_session_name", name: args } }
				: unavailable("Use /name followed by the session name");
		case "status":
		case "state":
			return { type: "rpc", command: { type: "get_state" } };
		case "context":
		case "session":
		case "stats":
			return { type: "rpc", command: { type: "get_session_stats" } };
		case "export":
		case "export-html":
		case "export_html": {
			const path = args === "html" ? "" : args.startsWith("html ") ? args.slice(5).trim() : args;
			if (path.toLowerCase().endsWith(".jsonl"))
				return unavailable("Managed /export supports HTML only; the original JSONL transcript remains on disk");
			return { type: "rpc", command: { type: "export_html", ...(path ? { outputPath: path } : {}) } };
		}
		case "steer":
			return args
				? { type: "rpc", command: { type: "steer", message: args } }
				: unavailable("Use /steer followed by a steering message");
	}
	const discovered = context.commands.find(
		(command) =>
			command.name === name ||
			(name.startsWith("skill:") && command.source === "skill" && command.name === name.slice(6)),
	);
	if (discovered?.source === "skill" || discovered?.source === "prompt") return { type: "prompt", message: text };
	if (discovered?.source === "extension") {
		if (context.rpcCompatibleExtensions?.includes(discovered.name)) return { type: "prompt", message: text };
		return unavailable(
			`/${name} has not been verified for RPC UI compatibility; it will not run against the idle UI host`,
		);
	}
	return unavailable(`/${name} is unavailable in managed conversations; unknown commands are not sent to the model`);
}
export async function stopSelectedSession(controller: SessionController): Promise<void> {
	const selected = controller.selected();
	if (!selected) throw new Error("No selected session to stop");
	const matches = () =>
		controller.selected()?.instance.id === selected.instance.id &&
		controller.selected()?.generation === selected.generation;
	const cleared = await controller.send({ type: "clear_queue" });
	if (cleared.success === false) throw new Error(cleared.error);
	if (cleared.command !== "clear_queue" || !("data" in cleared))
		throw new Error("Missing clear_queue acknowledgement");
	if (!matches()) throw new Error("Selected session changed while stopping");
	const draft = controller.draft();
	const text = [...cleared.data.steering, ...cleared.data.followUp, draft.text]
		.filter((text) => text.trim())
		.join("\n\n");
	controller.setDraft({ ...draft, text });
	if (!matches()) throw new Error("Selected session changed while stopping");
	const aborted = await controller.send({ type: "abort" });
	if (aborted.success === false) throw new Error(aborted.error);
}
