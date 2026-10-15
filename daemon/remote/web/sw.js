// Caches the app shell so the app opens, and says the Mac is unreachable, when the Mac is not.
// The API is never cached.
const CACHE = "bluclawd-shell-v6";
const SHELL = [
	"/",
	"/index.html",
	"/style.css",
	"/app.js",
	"/api.js",
	"/live.js",
	"/manifest.webmanifest",
	"/favicon-32.png",
	"/apple-touch-icon.png",
	"/icon-192.png",
	"/icon-512.png",
];

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(SHELL))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
			.then(() => self.clients.claim()),
	);
});

const NETWORK_TIMEOUT_MS = 3000;

/** @param {Request} request */
async function shellResponse(request) {
	const cached = () => caches.match(request).then((hit) => hit ?? caches.match("/"));
	const network = fetch(request);
	network.catch(() => {});
	const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS, null));
	try {
		const response = await Promise.race([network, timeout]);
		if (!response) return (await cached()) ?? network;
		if (!response.ok) return (await caches.match(request)) ?? response;
		const copy = response.clone();
		caches.open(CACHE).then((cache) => cache.put(request, copy));
		return response;
	} catch {
		return (await cached()) ?? Response.error();
	}
}

// iOS revokes the subscription of an app whose push shows nothing, so one is always shown.
self.addEventListener("push", (event) => {
	let data = {};
	try {
		data = event.data?.json() ?? {};
	} catch {
		// not JSON: the defaults below
	}
	const title = typeof data?.title === "string" && data.title ? data.title : "bluclawd";
	const body = typeof data?.body === "string" && data.body ? data.body : "A session needs you";
	const sessionId = typeof data?.sessionId === "string" ? data.sessionId : undefined;
	event.waitUntil(
		self.registration.showNotification(title, {
			body,
			data: { sessionId },
			...(sessionId ? { tag: sessionId, renotify: true } : {}),
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const sessionId = event.notification.data?.sessionId;
	const hash = typeof sessionId === "string" ? `#s/${encodeURIComponent(sessionId)}` : "";
	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
			const [client] = clients;
			if (!client) return self.clients.openWindow(`/${hash}`);
			await client.focus();
			if (sessionId) client.postMessage({ open: sessionId });
		}),
	);
});

self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);
	if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/"))
		return;
	// Network first: a new build shows at once; the cache is for when the Mac is slow, down or erroring.
	event.respondWith(shellResponse(event.request));
});
