// Caches the app shell so the app opens, and says the Mac is unreachable, when the Mac is not.
// The API is never cached.
const CACHE = "bluclawd-shell-v12";
const SHELL = [
	"/",
	"/index.html",
	"/style.css",
	"/app.js",
	"/api.js",
	"/diff.js",
	"/image.js",
	"/list.js",
	"/live.js",
	"/markdown.js",
	"/output.js",
	"/search.js",
	"/statusbar.js",
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

/**
 * Stale while revalidating: the cached copy at once, so the app opens instantly even while the Mac
 * sleeps, and the network's into the cache for the next open. Only what is not cached yet waits on
 * the network; a page the cache lacks falls back to the shell's.
 * @param {FetchEvent} event
 */
async function shellResponse(event) {
	const { request } = event;
	const network = fetch(request).then(async (response) => {
		if (response.ok) await (await caches.open(CACHE)).put(request, response.clone());
		return response;
	});
	const cached = await caches.match(request);
	if (cached) {
		event.waitUntil(network.catch(() => {}));
		return cached;
	}
	try {
		return await network;
	} catch {
		return (await caches.match("/")) ?? Response.error();
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
	// A query carries a secret (the manifest's handoff), which must not land in the cache.
	if (
		event.request.method !== "GET" ||
		url.origin !== self.location.origin ||
		url.pathname.startsWith("/api/") ||
		url.search
	)
		return;
	// A new build shows from the open after the one that fetched it.
	event.respondWith(shellResponse(event));
});
