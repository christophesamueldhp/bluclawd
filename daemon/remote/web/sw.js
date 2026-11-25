/** 0.0.N, one more for every change to the app, because a changed sw.js is what makes the phone update. */
const VERSION = "0.0.64";
const CACHE = `bluclawd-shell-${VERSION}`;
const SHELL = [
	"/",
	"/index.html",
	"/style.css",
	"/app.js",
	"/chat.js",
	"/composer.js",
	"/controls.js",
	"/skills.js",
	"/api.js",
	"/diff.js",
	"/image.js",
	"/list.js",
	"/live.js",
	"/markdown.js",
	"/output.js",
	"/pending.js",
	"/picker.js",
	"/search.js",
	"/statusbar.js",
	"/turn.js",
	"/mascot.js",
	"/icons.js",
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

/** @param {FetchEvent} event */
async function staleWhileRevalidate(event) {
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

/** @param {PushEvent} event */
function pushData(event) {
	try {
		return event.data?.json() ?? {};
	} catch {
		return {};
	}
}

// iOS revokes the subscription of an app whose push shows nothing, so one is always shown.
self.addEventListener("push", (event) => {
	const data = pushData(event);
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
	event.respondWith(staleWhileRevalidate(event));
});
