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
	/** This device's paired phones, `current` among them. @returns {Promise<import("./app.js").Device[]>} */
	devices: async () => (await call("GET", "/api/devices")).devices,
	/** @param {string} id */
	removeDevice: (id) => call("DELETE", `/api/devices/${encodeURIComponent(id)}`),
	sessions: async () => (await call("GET", "/api/sessions")).sessions,
	/** @returns {Promise<string[]>} */
	directories: async () => (await call("GET", "/api/directories")).directories,
	/** @param {string} cwd @param {string} task @returns {Promise<{ pane: string }>} */
	start: (cwd, task) => call("POST", "/api/sessions", { cwd, task }),
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
	/** @param {string} id */
	abort: (id) => call("POST", `${session(id)}/abort`, {}),
	/** @param {string} id */
	status: async (id) => (await call("GET", `${session(id)}/status`)).report,
	/** @param {string} id @param {string} provider @param {string} modelId */
	setModel: (id, provider, modelId) => call("POST", `${session(id)}/model`, { provider, id: modelId }),
	/** @param {string} id */
	compact: (id) => call("POST", `${session(id)}/compact`, {}),
	/** In the same session, back to before a message of yours, or to a reply. @param {string} id @param {string} entryId */
	tree: (id, entryId) => call("POST", `${session(id)}/tree`, { entryId }),
	/** A new session from before a message of yours. @param {string} id @param {string} entryId */
	fork: (id, entryId) => call("POST", `${session(id)}/fork`, { entryId }),
	/** @param {string} id */
	clone: (id) => call("POST", `${session(id)}/clone`, {}),
	/** The last lines its pane shows. @param {string} id @returns {Promise<string[]>} */
	screen: async (id) => (await call("GET", `${session(id)}/screen`)).lines,
	/** Press keys in its pane, by tmux name ("Up", "Enter", …). @param {string} id @param {string[]} keys */
	keys: (id, keys) => call("POST", `${session(id)}/keys`, { keys }),
	/** Type text into its pane as it is. @param {string} id @param {string} text */
	type: (id, text) => call("POST", `${session(id)}/keys`, { text }),
	/** `subscribed`: this device's notifications reach it. @returns {Promise<{ publicKey: string, subscribed: boolean }>} */
	pushKey: () => call("GET", "/api/push/key"),
	/** @param {PushSubscriptionJSON} subscription */
	subscribe: (subscription) => call("POST", "/api/push/subscribe", subscription),
	/** @param {string | undefined} sessionId */
	events(sessionId) {
		const token = encodeURIComponent(getToken() ?? "");
		const open = sessionId ? `&session=${encodeURIComponent(sessionId)}` : "";
		return new EventSource(`/api/events?token=${token}${open}`);
	},
};
