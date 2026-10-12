// Caches the app shell so the app opens, and says the Mac is unreachable, when the Mac is not.
// The API is never cached.
const CACHE = "bluclawd-shell-v3";
const SHELL = ["/", "/index.html", "/style.css", "/app.js", "/api.js", "/live.js", "/manifest.webmanifest"];

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

self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);
	if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/"))
		return;
	// Network first: a new build shows at once; the cache is for when the Mac is slow, down or erroring.
	event.respondWith(shellResponse(event.request));
});
