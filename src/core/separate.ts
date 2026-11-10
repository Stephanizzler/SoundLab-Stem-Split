// Splitting a whole song with a segment model, following demucs/apply.py and
// demucs/api.py: normalise by the mix's level, average over time shifts, cut
// into overlapping segments, blend them with triangular weights, and combine a
// bag of models with per-source weights. Pure TypeScript, so the browser worker
// and the Node tests run the same code.

export type SegmentModel = {
  sources: string[];
  sampleRate: number;
  segmentSamples: number;
  weights: number[][]; // [model][source]; one row per model in the bag
  // One segment (stereo, segmentSamples long) in, one estimate per source out: [source][channel][sample].
  run(modelIndex: number, segment: Float32Array[]): Promise<Float32Array[][]>;
};
export type SeparateOptions = {
  shifts: number; // 0 = no time-shift averaging; n = average n shifted passes (slower, slightly better)
  overlap: number; // fraction of each segment shared with the next, 0–0.9
  transitionPower?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
};

// A window onto a longer signal; reads outside the signal are silence.
type View = { base: Float32Array[]; offset: number; length: number };
const view = (base: Float32Array[], offset = 0, length = base[0].length - offset): View => ({ base, offset, length });
function sub(v: View, offset: number, length: number): View {
  return { base: v.base, offset: v.offset + offset, length: Math.min(v.length - offset, length) };
}
// TensorChunk.padded: centre the view in `target` samples, taking real neighbouring audio where it exists.
function padded(v: View, target: number): Float32Array[] {
  const delta = target - v.length;
  if (delta < 0) throw new Error("Segment is longer than the model accepts.");
  const start = v.offset - Math.floor(delta / 2), total = v.base[0].length;
  return v.base.map((ch) => {
    const out = new Float32Array(target);
    const from = Math.max(0, start), to = Math.min(total, start + target);
    if (to > from) out.set(ch.subarray(from, to), from - start);
    return out;
  });
}

// Deterministic stand-in for Demucs' random shifts, so a result can be redone exactly.
export function shiftOffsets(shifts: number, sampleRate: number) {
  const max = Math.floor(0.5 * sampleRate);
  return Array.from({ length: shifts }, (_, k) => Math.floor((max * (k + 0.5)) / shifts));
}

export function chunkCount(length: number, segment: number, overlap: number) {
  return Math.ceil(length / Math.floor((1 - overlap) * segment));
}
// How many model runs a separation takes, for progress and time estimates.
export function totalRuns(model: Pick<SegmentModel, "sampleRate" | "segmentSamples" | "weights">, length: number, o: Pick<SeparateOptions, "shifts" | "overlap">) {
  const per = o.shifts > 0
    ? shiftOffsets(o.shifts, model.sampleRate).reduce((n, off) => n + chunkCount(length + Math.floor(0.5 * model.sampleRate) - off, model.segmentSamples, o.overlap), 0)
    : chunkCount(length, model.segmentSamples, o.overlap);
  return per * model.weights.filter((w) => w.some((x) => x !== 0)).length;
}

class Cancelled extends Error {
  constructor() { super("Separation cancelled."); this.name = "AbortError"; }
}

export async function separate(mix: Float32Array[], model: SegmentModel, o: SeparateOptions): Promise<Float32Array[][]> {
  if (mix.length !== 2) throw new Error("The model takes stereo audio.");
  if (!(o.overlap >= 0 && o.overlap < 0.95)) throw new Error("Overlap must be between 0 and 0.95.");
  if (!(Number.isInteger(o.shifts) && o.shifts >= 0 && o.shifts <= 10)) throw new Error("Shifts must be a whole number from 0 to 10.");
  const length = mix[0].length, S = model.sources.length;
  if (!length) throw new Error("The audio is empty.");
  const total = totalRuns(model, length, o);
  let done = 0;
  o.onProgress?.(0, total);

  // api.py: normalise by the mean and standard deviation of the mono mix.
  let sum = 0;
  for (let i = 0; i < length; i++) sum += (mix[0][i] + mix[1][i]) / 2;
  const mean = sum / length;
  let sq = 0;
  for (let i = 0; i < length; i++) { const d = (mix[0][i] + mix[1][i]) / 2 - mean; sq += d * d; }
  const std = Math.sqrt(sq / Math.max(1, length - 1)) + 1e-8;
  const norm = mix.map((ch) => Float32Array.from(ch, (v) => (v - mean) / std));

  const segment = model.segmentSamples;
  const tp = o.transitionPower ?? 1;
  const weight = new Float32Array(segment);
  const half = Math.floor(segment / 2);
  for (let i = 0; i < segment; i++) weight[i] = i < half ? i + 1 : segment - i;
  const peak = Math.max(half, segment - half);
  for (let i = 0; i < segment; i++) weight[i] = (weight[i] / peak) ** tp;

  const zeros = (n: number) => Array.from({ length: S }, () => [new Float32Array(n), new Float32Array(n)]);

  async function one(m: number, v: View) {
    if (o.signal?.aborted) throw new Cancelled();
    const out = await model.run(m, padded(v, segment));
    done++;
    o.onProgress?.(done, total);
    const delta = segment - v.length, left = Math.floor(delta / 2);
    return out.map((src) => src.map((ch) => ch.subarray(left, left + v.length)));
  }
  async function split(m: number, v: View) {
    const out = zeros(v.length), sumW = new Float32Array(v.length);
    const stride = Math.floor((1 - o.overlap) * segment);
    for (let offset = 0; offset < v.length; offset += stride) {
      const chunk = sub(v, offset, segment), res = await one(m, chunk);
      for (let s = 0; s < S; s++)
        for (let c = 0; c < 2; c++) {
          const dst = out[s][c], src = res[s][c];
          for (let i = 0; i < chunk.length; i++) dst[offset + i] += weight[i] * src[i];
        }
      for (let i = 0; i < chunk.length; i++) sumW[offset + i] += weight[i];
    }
    for (const src of out) for (const ch of src) for (let i = 0; i < ch.length; i++) ch[i] /= sumW[i];
    return out;
  }
  async function apply(m: number, v: View) {
    if (!o.shifts) return split(m, v);
    const maxShift = Math.floor(0.5 * model.sampleRate);
    const base = padded(v, v.length + 2 * maxShift), out = zeros(v.length);
    const offsets = shiftOffsets(o.shifts, model.sampleRate);
    for (const off of offsets) {
      const res = await split(m, view(base, off, v.length + maxShift - off));
      for (let s = 0; s < S; s++)
        for (let c = 0; c < 2; c++) {
          const dst = out[s][c], src = res[s][c], from = maxShift - off;
          for (let i = 0; i < v.length; i++) dst[i] += src[from + i] / offsets.length;
        }
    }
    return out;
  }

  const est = zeros(length), totals = new Array(S).fill(0);
  for (let m = 0; m < model.weights.length; m++) {
    const w = model.weights[m];
    if (w.every((x) => x === 0)) continue;
    const res = await apply(m, view(norm));
    for (let s = 0; s < S; s++) {
      totals[s] += w[s];
      if (!w[s]) continue;
      for (let c = 0; c < 2; c++) { const dst = est[s][c], src = res[s][c]; for (let i = 0; i < length; i++) dst[i] += w[s] * src[i]; }
    }
  }
  for (let s = 0; s < S; s++)
    for (const ch of est[s]) for (let i = 0; i < length; i++) ch[i] = (ch[i] / totals[s]) * std + mean;
  return est;
}
