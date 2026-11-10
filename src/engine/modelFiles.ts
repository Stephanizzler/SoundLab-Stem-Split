// Downloads model files once, checks their SHA-256 against the manifest, and
// keeps them in the browser's Cache Storage so later visits work offline.
import type { ModelFile } from "../core/manifest.ts";

const CACHE = "soundlab-stem-split-models-v1";

async function hex(buf: ArrayBuffer) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function fetchModelFile(f: ModelFile, base: string, onBytes: (n: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
  const url = new URL(f.url, base).href;
  const cache = typeof caches !== "undefined" ? await caches.open(CACHE).catch(() => null) : null;
  const hit = await cache?.match(url);
  if (hit) {
    const buf = await hit.arrayBuffer();
    if ((await hex(buf)) === f.sha256) { onBytes(buf.byteLength); return new Uint8Array(buf); }
    await cache?.delete(url); // stale or damaged: fetch again
  }
  const parts: Uint8Array[] = [];
  let got = 0;
  for (const part of f.parts ?? [{ url: f.url, bytes: f.bytes }]) {
    const res = await fetch(new URL(part.url, base).href, { signal });
    if (!res.ok || !res.body) throw new Error(`Could not download the model (${res.status} ${res.statusText}).`);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length; onBytes(got);
    }
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  if ((await hex(out.buffer)) !== f.sha256) throw new Error("The downloaded model does not match its checksum, so it was not used.");
  await cache?.put(url, new Response(out.slice().buffer, { headers: { "content-type": "application/octet-stream" } })).catch(() => {});
  return out;
}

export async function cachedModelBytes(files: ModelFile[], base: string) {
  if (typeof caches === "undefined") return 0;
  const cache = await caches.open(CACHE).catch(() => null);
  let n = 0;
  for (const f of files) if (await cache?.match(new URL(f.url, base).href)) n += f.bytes;
  return n;
}
