// Adds the cross-origin isolation headers on hosts that cannot send them (such
// as GitHub Pages), so ONNX Runtime can use every CPU core. Registered by
// index.html only when the page is not already isolated.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.cache === "only-if-cached" && r.mode !== "same-origin") return;
  // Always check for a new page (a quick revalidation), so an update shows on the next visit.
  // Other files have hashed names or are checksum-checked, so they can come from the browser cache.
  const response = r.mode === "navigate" ? fetch(r.url, { cache: "no-cache", credentials: "same-origin" }) : fetch(r);
  e.respondWith(
    response.then((res) => {
      if (res.status === 0) return res; // opaque: leave as is
      const headers = new Headers(res.headers);
      headers.set("Cross-Origin-Embedder-Policy", "require-corp");
      headers.set("Cross-Origin-Opener-Policy", "same-origin");
      headers.set("Cross-Origin-Resource-Policy", "cross-origin");
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }),
  );
});
