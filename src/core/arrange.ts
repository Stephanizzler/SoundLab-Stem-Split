// Turning the model's stems into what the user asked for: a vocals + instrumental
// pair, and stems for just a selection of the song that still line up with it.

export type Layout = "all" | "vocals-instrumental";
export type Stem = { source: string; channels: Float32Array[] };

// Vocals + instrumental: everything that is not the vocal, summed. The pair adds
// up to exactly what the full set of stems adds up to.
export function arrange(stems: Stem[], layout: Layout): Stem[] {
  if (layout === "all") return stems;
  const vocals = stems.find((s) => s.source === "vocals");
  if (!vocals) throw new Error("This model has no vocal stem, so it cannot make a vocals + instrumental pair.");
  const rest = stems.filter((s) => s !== vocals);
  const instrumental = vocals.channels.map((ch, c) => {
    const out = new Float32Array(ch.length);
    for (const s of rest) { const x = s.channels[c]; for (let i = 0; i < out.length; i++) out[i] += x[i]; }
    return out;
  });
  return [vocals, { source: "instrumental", channels: instrumental }];
}

export type Range = { start: number; end: number }; // samples, end exclusive

export function checkRange(r: Range, length: number, sampleRate: number) {
  if (!(Number.isInteger(r.start) && Number.isInteger(r.end) && r.start >= 0 && r.end <= length && r.end > r.start))
    throw new Error("The selection is outside the song.");
  if (r.end - r.start < sampleRate) throw new Error("Select at least one second.");
}

// The part to separate: the selection plus some real audio either side, so the
// model hears the context and the selection's edges are not cut off mid-note.
export function withContext(r: Range, length: number, context: number): Range {
  return { start: Math.max(0, r.start - context), end: Math.min(length, r.end + context) };
}
export const slice = (channels: Float32Array[], r: Range) => channels.map((ch) => ch.slice(r.start, r.end));

// Puts audio separated from `from` back into a full-length track: the selection
// is kept, everything outside it is silence, so it still lines up at zero.
export function place(channels: Float32Array[], from: Range, keep: Range, length: number): Float32Array[] {
  return channels.map((ch) => {
    const out = new Float32Array(length);
    out.set(ch.subarray(keep.start - from.start, keep.end - from.start), keep.start);
    return out;
  });
}
// Zero outside the range (to measure only the part that was split).
export const only = (channels: Float32Array[], r: Range) => channels.map((ch) => { const out = new Float32Array(ch.length); out.set(ch.subarray(r.start, r.end), r.start); return out; });
