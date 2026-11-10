// What the app does with the model's estimates: fit them to the file's channel
// layout, measure what they leave out, and optionally put that remainder back.

export const STEM_NAMES: Record<string, string> = {
  vocals: "Vocals", drums: "Drums", bass: "Bass", other: "Other", guitar: "Guitar", piano: "Piano", instrumental: "Instrumental", residual: "Remainder",
};
export const stemName = (id: string) => STEM_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
// Order a producer expects to see them in.
const ORDER = ["vocals", "instrumental", "drums", "bass", "guitar", "piano", "other"];
export const displayOrder = (ids: string[]) => [...ids].sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));

// Stereo for the model: mono is played from both sides; more than two channels is refused.
export function toStereo(channels: Float32Array[]): Float32Array[] {
  if (channels.length === 1) return [channels[0], channels[0]];
  if (channels.length === 2) return channels;
  throw new Error(`Stem Split works on mono and stereo files; this one has ${channels.length} channels.`);
}
// Back to the file's own layout: a mono file gets mono stems (the average of both sides).
export function fromStereo(stereo: Float32Array[], channelCount: number): Float32Array[] {
  if (channelCount === 2) return stereo;
  const [l, r] = stereo, m = new Float32Array(l.length);
  for (let i = 0; i < m.length; i++) m[i] = (l[i] + r[i]) / 2;
  return [m];
}

// mix minus the sum of the stems.
export function residual(mix: Float32Array[], stems: Float32Array[][]): Float32Array[] {
  return mix.map((ch, c) => {
    const out = Float32Array.from(ch);
    for (const s of stems) { const x = s[c]; for (let i = 0; i < out.length; i++) out[i] -= x[i]; }
    return out;
  });
}
const energy = (chs: Float32Array[]) => { let e = 0; for (const ch of chs) for (const v of ch) e += v * v; return e; };

// How far below the mix the remainder sits, in dB. -60 means the stems add back
// to the mix almost exactly; -20 means about 10% of the signal is missing or extra.
export function nullDepthDb(mix: Float32Array[], rest: Float32Array[]) {
  const m = energy(mix), r = energy(rest);
  if (m === 0) return r === 0 ? -Infinity : 0;
  return r === 0 ? -Infinity : 10 * Math.log10(r / m);
}

// "Make the stems add up to the mix": share the remainder out to the stems in
// proportion to each stem's level at that moment (per 1024-sample block), so the
// sum nulls exactly and nothing is dumped in one stem. Off by default.
export function distributeResidual(stems: Float32Array[][], rest: Float32Array[], block = 1024): Float32Array[][] {
  const out = stems.map((s) => s.map((ch) => Float32Array.from(ch)));
  const n = rest[0].length;
  for (let c = 0; c < rest.length; c++)
    for (let start = 0; start < n; start += block) {
      const end = Math.min(n, start + block);
      const e = stems.map((s) => { let x = 1e-12; for (let i = start; i < end; i++) x += s[c][i] * s[c][i]; return x; });
      const total = e.reduce((a, b) => a + b, 0);
      for (let k = 0; k < stems.length; k++) {
        const share = e[k] / total, dst = out[k][c], r = rest[c];
        for (let i = start; i < end; i++) dst[i] += share * r[i];
      }
    }
  return out;
}

export function peak(chs: Float32Array[]) {
  let p = 0;
  for (const ch of chs) for (const v of ch) { const a = Math.abs(v); if (a > p) p = a; }
  return p;
}
