// Caches the app shell so the app opens, and says the Mac is unreachable, when the Mac is not.
// The API is never cached.
const CACHE = "bluclawd-shell-v1";
const SHELL = ["/", "/index.html", "/style.css", "/app.js", "/api.js", "/manifest.webmanifest"];

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

self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);
	if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/"))
		return;
	// Network first: a new build shows at once; the cache is only for when the Mac is unreachable.
	event.respondWith(
		fetch(event.request)
			.then((response) => {
				const copy = response.clone();
				caches.open(CACHE).then((cache) => cache.put(event.request, copy));
				return response;
			})
			.catch(() => caches.match(event.request).then((cached) => cached ?? caches.match("/"))),
	);
});
