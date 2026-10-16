// @ts-check
/** The daemon's /api, with the paired device's token from this app's own storage. */

const TOKEN_KEY = "bluclawd.token";

export function getToken() {
	try {
		return localStorage.getItem(TOKEN_KEY);
	} catch {
		return null;
	}
}

/** @param {string} token */
export function setToken(token) {
	localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
	try {
		localStorage.removeItem(TOKEN_KEY);
	} catch {
		// storage blocked: nothing to clear
	}
}

/**
 * What pairs this app in its address: the secret in the link /remote-control's QR code opens
 * (`#pair=`), or the handoff the Home Screen app opens with (`#handoff=`, its manifest's start_url).
 * @param {string} hash @returns {{ secret: string } | { handoff: string } | undefined}
 */
export function pairLink(hash) {
	const match = /^#(pair|handoff)=([\w-]{22})$/.exec(hash);
	if (!match) return undefined;
	return match[1] === "pair" ? { secret: match[2] } : { handoff: match[2] };
}

/** The token was revoked (or never valid): the app goes back to pairing. */
export class Unauthorized extends Error {}

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
	 * @param {{ code: string } | { secret: string } | { handoff: string }} credential
	 * @param {string} deviceName @returns {Promise<string>}
	 */
	async pair(credential, deviceName) {
		const res = await fetch("handoff" in credential ? "/api/pair/handoff" : "/api/pair", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...credential, deviceName }),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
		return data.token;
	},
	/** Pairs the Home Screen app this browser adds, once. @returns {Promise<string>} */
	handoff: async () => (await call("POST", "/api/handoff", {})).handoff,
	/** The paired phones the Mac lists to this one, `current` among them. @returns {Promise<import("./app.js").Device[]>} */
	devices: async () => (await call("GET", "/api/devices")).devices,
	/** Only ever this phone's own id: the Mac removes any other. @param {string} id */
	removeDevice: (id) => call("DELETE", `/api/devices/${encodeURIComponent(id)}`),
	sessions: () => call("GET", "/api/sessions"),
	/** @returns {Promise<string[]>} */
	directories: async () => (await call("GET", "/api/directories")).directories,
	/** `model`: "provider/id", else pi's default. @param {string} cwd @param {string} task @param {string} [model] @returns {Promise<{ pane: string }>} */
	start: (cwd, task, model) => call("POST", "/api/sessions", model ? { cwd, task, model } : { cwd, task }),
	/** What a new session can start with: the running panes' models. @returns {Promise<import("./statusbar.js").ReportModel[]>} */
	models: async () => (await call("GET", "/api/models")).models,
	/** A pane takes the name on its next heartbeat. @param {string} id @param {string} name */
	rename: (id, name) => call("POST", `${session(id)}/rename`, { name }),
	/** @param {string} id @param {boolean} pinned */
	pin: (id, pinned) => call("POST", `${session(id)}/pin`, { pinned }),
	/** A stored row only; its session file stays on the Mac. @param {string} id */
	deleteSession: (id) => call("DELETE", session(id)),
	/**
	 * The latest messages, or those before the message `before`; `more`: older ones are left.
	 * @param {string} id @param {string} [before] @returns {Promise<{ messages: any[], more: boolean }>}
	 */
	messages: (id, before) =>
		call("GET", `${session(id)}/messages?limit=100${before ? `&before=${encodeURIComponent(before)}` : ""}`),
	/**
	 * A stored session resumes in a new pane, named in the reply; only a running one takes images.
	 * @param {string} id @param {string} text @param {{ mimeType: string, data: string }[]} [images] base64
	 * @returns {Promise<{ pane?: string }>}
	 */
	prompt: (id, text, images = []) =>
		call("POST", `${session(id)}/prompt`, images.length ? { text, images } : { text }),
	/**
	 * An image in a message, by the message's id and its position there: an `<img>` cannot send the token.
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
	/**
	 * A tool result's whole output, which a message cuts short.
	 * @param {string} id @param {string} entryId @returns {Promise<{ text: string, truncated: boolean }>}
	 */
	output: (id, entryId) => call("GET", `${session(id)}/messages/${encodeURIComponent(entryId)}/output`),
	/** @param {string} id */
	abort: (id) => call("POST", `${session(id)}/abort`, {}),
	/** `cols`: the status bar's width in characters, for pistatusline's lines. @param {string} id @param {number} [cols] */
	status: async (id, cols) => (await call("GET", `${session(id)}/status${cols ? `?cols=${cols}` : ""}`)).report,
	/** What its prompt runs for a "/": pi's own commands, then the rest. @param {string} id @returns {Promise<import("./statusbar.js").Command[]>} */
	commands: async (id) => (await call("GET", `${session(id)}/commands`)).commands,
	/** A background task's last lines. @param {string} id @param {string} taskId @returns {Promise<{ lines: string[], size: number }>} */
	taskOutput: (id, taskId) => call("GET", `${session(id)}/tasks/${encodeURIComponent(taskId)}/output`),
	/** @param {string} id @param {string} taskId */
	stopTask: (id, taskId) => call("POST", `${session(id)}/tasks/${encodeURIComponent(taskId)}/stop`, {}),
	/** @param {string} id @param {string} provider @param {string} modelId */
	setModel: (id, provider, modelId) => call("POST", `${session(id)}/model`, { provider, id: modelId }),
	/** One of the levels its report offers. @param {string} id @param {string} level */
	setThinking: (id, level) => call("POST", `${session(id)}/thinking`, { level }),
	/** pi's defaultProjectTrust: "always", "ask" or "never". @param {string} id @param {string} trust */
	setTrust: (id, trust) => call("POST", `${session(id)}/trust`, { trust }),
	/** `subscribed`: this device's notifications reach it. @returns {Promise<{ publicKey: string, subscribed: boolean }>} */
	pushKey: () => call("GET", "/api/push/key"),
	/** @param {PushSubscriptionJSON} subscription */
	subscribe: (subscription) => call("POST", "/api/push/subscribe", subscription),
	/** This device's subscription forgotten by the Mac. */
	unsubscribe: () => call("POST", "/api/push/unsubscribe", {}),
	/** @param {string | undefined} sessionId */
	events(sessionId) {
		const token = encodeURIComponent(getToken() ?? "");
		const open = sessionId ? `&session=${encodeURIComponent(sessionId)}` : "";
		return new EventSource(`/api/events?token=${token}${open}`);
	},
};
