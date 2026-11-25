// @ts-check

const TOKEN_KEY = "bluclawd.token";
export const PING_MS = 25_000;

/** @template T @param {() => T} fn @param {T} fallback @returns {T} */
export function tryStorage(fn, fallback) {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

export function getToken() {
	return tryStorage(() => localStorage.getItem(TOKEN_KEY), null);
}

/** @param {string} token */
export function setToken(token) {
	localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
	tryStorage(() => localStorage.removeItem(TOKEN_KEY), undefined);
}

/** @param {string} hash @returns {{ secret: string } | undefined} */
export function pairLink(hash) {
	const match = /^#pair=([\w-]{22})$/.exec(hash);
	return match ? { secret: match[1] } : undefined;
}

export class Unauthorized extends Error {}

/** @param {string | undefined} sessionId @param {string} streamId */
function events(sessionId, streamId) {
	const query = new URLSearchParams({ stream: streamId });
	if (sessionId) query.set("session", sessionId);
	const path = `/api/events?${query}`;
	let retryMs = 3000;
	/** @type {AbortController | undefined} */
	let attempt;
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let retry;
	const stream = Object.assign(new EventTarget(), { close, reconnect: () => void connect() });
	stream.reconnect();
	return stream;

	function close() {
		clearTimeout(retry);
		attempt?.abort();
	}

	async function connect() {
		close();
		attempt = new AbortController();
		const { signal } = attempt;
		try {
			await read(signal);
		} catch (error) {
			if (signal.aborted) return;
			if (error instanceof Unauthorized) {
				stream.dispatchEvent(new Event("unauthorized"));
				return;
			}
		}
		if (signal.aborted) return;
		stream.dispatchEvent(new Event("error"));
		if (!signal.aborted) retry = setTimeout(connect, retryMs);
	}

	/** @param {AbortSignal} signal */
	async function read(signal) {
		const token = getToken() ?? "";
		const headers = new Headers({ accept: "text/event-stream", authorization: `Bearer ${token}` });
		const res = await fetch(path, { headers, signal });
		const type = res.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
		if (res.status !== 200 || type !== "text/event-stream" || !res.body) {
			await res.body?.cancel();
			if (res.status === 401 && !signal.aborted) {
				if (token === getToken()) clearToken();
				throw new Unauthorized("unauthorized");
			}
			return;
		}
		if (signal.aborted) return;
		stream.dispatchEvent(new Event("open"));

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let partial = "";
		let afterCr = false;
		let event = "";
		/** @type {string[]} */
		let data = [];
		try {
			while (!signal.aborted) {
				const { value, done } = await reader.read();
				if (done || signal.aborted) return;
				const chunk = decoder.decode(value, { stream: true });
				if (!chunk) continue;
				const text = partial + (afterCr && chunk.startsWith("\n") ? chunk.slice(1) : chunk);
				afterCr = text.endsWith("\r");
				const lines = text.split(/\r\n|\r|\n/);
				partial = lines.pop() ?? "";
				for (const line of lines) {
					if (signal.aborted) return;
					if (line === "") {
						if (data.length)
							stream.dispatchEvent(new MessageEvent(event || "message", { data: data.join("\n") }));
						event = "";
						data = [];
						continue;
					}
					const colon = line.indexOf(":");
					const field = colon < 0 ? line : line.slice(0, colon);
					const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
					if (field === "data") data.push(value);
					else if (field === "event") event = value;
					else if (field === "retry" && /^\d+$/.test(value)) retryMs = Math.min(Number(value), 2_147_483_647);
				}
			}
		} finally {
			reader.releaseLock();
		}
	}
}

/**
 * @param {string} method
 * @param {string} path
 * @param {object} [body]
 * @returns {Promise<any>}
 */
async function call(method, path, body) {
	/** @type {Record<string, string>} */
	const headers = { authorization: `Bearer ${getToken() ?? ""}` };
	if (body) headers["content-type"] = "application/json";
	const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
	if (res.status === 401) {
		clearToken();
		throw new Unauthorized("unauthorized");
	}
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
	return data;
}

/** @param {string} id */
const session = (id) => `/api/sessions/${encodeURIComponent(id)}`;

export const api = {
	/**
	 * @param {{ code: string } | { secret: string }} credential
	 * @param {string} deviceName @returns {Promise<string>}
	 */
	async pair(credential, deviceName) {
		const res = await fetch("/api/pair", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...credential, deviceName }),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
		return data.token;
	},
	/** @returns {Promise<import("./app.js").Device[]>} */
	devices: async () => (await call("GET", "/api/devices")).devices,
	/** @param {string} ownId */
	removeThisDevice: (ownId) => call("DELETE", `/api/devices/${encodeURIComponent(ownId)}`),
	sessions: () => call("GET", "/api/sessions"),
	/** @param {string} cwd @returns {Promise<{ id?: string, sessionFile: string, cwd: string, label: string }[]>} */
	pastSessions: async (cwd) => (await call("GET", `/api/sessions/past?cwd=${encodeURIComponent(cwd)}`)).sessions,
	/** @param {string} cwd @param {string} sessionFile @returns {Promise<{ pane: string, id: string }>} */
	resume: (cwd, sessionFile) => call("POST", "/api/sessions/resume", { cwd, sessionFile }),
	/** @returns {Promise<string[]>} */
	directories: async () => (await call("GET", "/api/directories")).directories,
	/** @param {string} path @returns {Promise<string[]>} */
	completeDirectory: async (path) =>
		(await call("GET", `/api/directories?under=${encodeURIComponent(path)}`)).directories,
	/** @param {string} cwd @param {string} task @param {string} [model] @returns {Promise<{ pane: string, id: string }>} */
	start: (cwd, task, model) => call("POST", "/api/sessions", model ? { cwd, task, model } : { cwd, task }),
	/** @returns {Promise<import("./statusbar.js").ReportModel[]>} */
	models: async () => (await call("GET", "/api/models")).models,
	/** @param {string} id @param {string} name */
	rename: (id, name) => call("POST", `${session(id)}/rename`, { name }),
	/** @param {string} id @param {boolean} pinned */
	pin: (id, pinned) => call("POST", `${session(id)}/pin`, { pinned }),
	/** @param {string} id */
	deleteSession: (id) => call("DELETE", session(id)),
	/** @param {string} id @param {string} [before] @returns {Promise<{ messages: any[], more: boolean }>} */
	messages: (id, before) =>
		call("GET", `${session(id)}/messages?limit=100${before ? `&before=${encodeURIComponent(before)}` : ""}`),
	/**
	 * @param {string} id @param {string} text @param {{ mimeType: string, data: string }[]} images
	 * @param {string} promptId @param {string[]} [skills]
	 * @returns {Promise<{ pane?: string, lifetime?: string }>}
	 */
	prompt: (id, text, images, promptId, skills) =>
		call("POST", `${session(id)}/prompt`, {
			text,
			...(images.length ? { images } : {}),
			id: promptId,
			...(skills?.length ? { skills } : {}),
		}),
	/**
	 * @param {string} id @param {{ id: string, lifetime: string }[]} waiting
	 * @returns {Promise<import("./statusbar.js").PromptOutcome[]>}
	 */
	outcomes: async (id, waiting) => {
		const query = waiting.map((w) => `prompt=${encodeURIComponent(`${w.id}@${w.lifetime}`)}`).join("&");
		return (await call("GET", `${session(id)}/outcomes?${query}`)).outcomes;
	},
	/**
	 * An image in a message, by the message's id and its position there, because an `<img>` cannot send the token.
	 * @param {string} id @param {string} entryId @param {number} index @returns {Promise<Blob>}
	 */
	async image(id, entryId, index) {
		const res = await fetch(`${session(id)}/images/${encodeURIComponent(entryId)}/${index}`, {
			headers: { authorization: `Bearer ${getToken() ?? ""}` },
		});
		if (res.status === 401) {
			clearToken();
			throw new Unauthorized("unauthorized");
		}
		if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
		return res.blob();
	},
	/** @param {string} id @param {string} entryId @returns {Promise<{ text: string, truncated: boolean }>} */
	output: (id, entryId) => call("GET", `${session(id)}/messages/${encodeURIComponent(entryId)}/output`),
	/** @param {string} id */
	abort: (id) => call("POST", `${session(id)}/abort`, {}),
	/** @param {string} id @param {number} [cols] */
	status: async (id, cols) => (await call("GET", `${session(id)}/status${cols ? `?cols=${cols}` : ""}`)).report,
	/** @param {string} id @returns {Promise<import("./statusbar.js").Command[]>} */
	commands: async (id) => (await call("GET", `${session(id)}/commands`)).commands,
	/** @param {string} id @param {string} taskId @returns {Promise<{ lines: string[], size: number }>} */
	taskOutput: (id, taskId) => call("GET", `${session(id)}/tasks/${encodeURIComponent(taskId)}/output`),
	/** @param {string} id @param {string} taskId */
	stopTask: (id, taskId) => call("POST", `${session(id)}/tasks/${encodeURIComponent(taskId)}/stop`, {}),
	/** @param {string} id @param {string} provider @param {string} modelId */
	setModel: (id, provider, modelId) => call("POST", `${session(id)}/model`, { provider, id: modelId }),
	/** @param {string} id @param {string} level */
	setThinking: (id, level) => call("POST", `${session(id)}/thinking`, { level }),
	/** @param {string} id @param {"always" | "ask" | "never"} trust */
	setTrust: (id, trust) => call("POST", `${session(id)}/trust`, { trust }),
	/** @returns {Promise<{ publicKey: string, subscribed: boolean }>} */
	pushKey: () => call("GET", "/api/push/key"),
	/** @param {PushSubscriptionJSON} subscription */
	subscribe: (subscription) => call("POST", "/api/push/subscribe", subscription),
	unsubscribe: () => call("POST", "/api/push/unsubscribe", {}),
	events,
	/** A page going hidden may not finish a plain fetch; `keepalive` lets this one outlive it. @param {string} stream */
	hidden(stream) {
		fetch("/api/hidden", {
			method: "POST",
			keepalive: true,
			headers: { authorization: `Bearer ${getToken() ?? ""}`, "content-type": "application/json" },
			body: JSON.stringify({ stream }),
		}).catch(() => {});
	},
};
