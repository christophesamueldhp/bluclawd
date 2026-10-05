import type {
	JsonAgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";
export class FakeViewChild {
	static children: FakeViewChild[] = [];
	events = new Set<(event: JsonAgentSessionEvent) => void>();
	exits = new Set<(error?: Error) => void>();
	uiHandler?: (request: RpcExtensionUIRequest) => void;
	sent: RpcCommand[] = [];
	answered: RpcExtensionUIResponse[] = [];
	disposed = false;
	readonly options: { sessionFile?: string };
	constructor(options: { sessionFile?: string }) {
		this.options = options;
		FakeViewChild.children.push(this);
	}
	onEvent(fn: (event: JsonAgentSessionEvent) => void) {
		this.events.add(fn);
		return () => {
			this.events.delete(fn);
		};
	}
	onExit(fn: (error?: Error) => void) {
		this.exits.add(fn);
		return () => {
			this.exits.delete(fn);
		};
	}
	setUiRequestHandler(fn?: (request: RpcExtensionUIRequest) => void) {
		this.uiHandler = fn;
	}
	handleUiResponse(answer: RpcExtensionUIResponse) {
		this.answered.push(answer);
	}
	async send(command: RpcCommand): Promise<RpcResponse> {
		this.sent.push(command);
		if (command.type === "get_state")
			return {
				type: "response",
				id: command.id,
				command: "get_state",
				success: true,
				data: {
					sessionId: "child",
					sessionFile: this.options.sessionFile,
					thinkingLevel: "off",
					isStreaming: false,
					isCompacting: false,
					steeringMode: "all",
					followUpMode: "all",
					autoCompactionEnabled: true,
					messageCount: 0,
					pendingMessageCount: 0,
				},
			};
		return { type: "response", id: command.id, command: command.type, success: true } as RpcResponse;
	}
	async dispose() {
		this.disposed = true;
	}
	emit(event: JsonAgentSessionEvent) {
		for (const fn of this.events) fn(event);
	}
	ui(request: RpcExtensionUIRequest) {
		this.uiHandler?.(request);
	}
	crash() {
		for (const fn of this.exits) fn(new Error("child failed"));
	}
}
