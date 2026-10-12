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

function clearToken() {
	try {
		localStorage.removeItem(TOKEN_KEY);
	} catch {
		// storage blocked: nothing to clear
	}
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
	/** @param {string} code @param {string} deviceName @returns {Promise<string>} */
	async pair(code, deviceName) {
		const res = await fetch("/api/pair", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code, deviceName }),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
		return data.token;
	},
	sessions: async () => (await call("GET", "/api/sessions")).sessions,
	/** @returns {Promise<string[]>} */
	directories: async () => (await call("GET", "/api/directories")).directories,
	/** @param {string} cwd @param {string} task @returns {Promise<{ pane: string }>} */
	start: (cwd, task) => call("POST", "/api/sessions", { cwd, task }),
	/** @param {string} id */
	messages: async (id) => (await call("GET", `${session(id)}/messages?limit=100`)).messages,
	/** A stored session resumes in a new pane, named in the reply. @param {string} id @param {string} text @returns {Promise<{ pane?: string }>} */
	prompt: (id, text) => call("POST", `${session(id)}/prompt`, { text }),
	/** @param {string} id */
	abort: (id) => call("POST", `${session(id)}/abort`, {}),
	/** @param {string | undefined} sessionId */
	events(sessionId) {
		const token = encodeURIComponent(getToken() ?? "");
		const open = sessionId ? `&session=${encodeURIComponent(sessionId)}` : "";
		return new EventSource(`/api/events?token=${token}${open}`);
	},
};
