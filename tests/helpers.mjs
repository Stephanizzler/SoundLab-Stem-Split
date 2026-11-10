import fs from "node:fs";
import path from "node:path";
export const fixture = (name) => {
  const b = fs.readFileSync(path.join(import.meta.dirname, "fixtures", name));
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
export const sine = (rate, seconds, hz, amp = 0.5, phase = 0) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin(2 * Math.PI * hz * (i / rate) + phase));
export const maxDiff = (a, b, from = 0, to = Math.min(a.length, b.length)) => {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
export const db = (x) => 20 * Math.log10(x);
let n = 0, t = Date.parse("2026-11-10T00:00:00Z");
export const clock = { id: () => `id-${++n}`, now: () => new Date((t += 1000)).toISOString() };
