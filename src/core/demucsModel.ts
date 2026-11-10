// Turns an ONNX Runtime session (web or Node) running an exported HTDemucs
// into a SegmentModel: computes the spectrogram input, runs the network, and
// adds the inverse-STFT of the frequency branch to the time branch.
import { demucsISpec, demucsSpec } from "./demucsSpec.ts";
import type { ModelManifest } from "./manifest.ts";
import type { SegmentModel } from "./separate.ts";

export type Tensor = { data: Float32Array; dims: readonly number[] };
// Runs model `index` of the bag on named float32 inputs and returns its outputs by name.
export type Infer = (index: number, feeds: { mix: Tensor; spec: Tensor }) => Promise<{ time: Tensor; zout: Tensor }>;

export function demucsSegmentModel(m: ModelManifest, infer: Infer): SegmentModel {
  const T = m.segmentSamples, F = Math.ceil(T / m.hop), bins = m.nfft / 2, S = m.sources.length, plane = bins * F;
  return {
    sources: m.sources,
    sampleRate: m.sampleRate,
    segmentSamples: T,
    weights: m.weights,
    async run(index, segment) {
      const mix = new Float32Array(2 * T);
      mix.set(segment[0], 0);
      mix.set(segment[1], T);
      // Complex as channels: [left re, left im, right re, right im].
      const spec = new Float32Array(4 * plane);
      for (let c = 0; c < 2; c++) {
        const z = demucsSpec(segment[c], m.nfft, m.hop);
        spec.set(z.re, (2 * c) * plane);
        spec.set(z.im, (2 * c + 1) * plane);
      }
      const { time, zout } = await infer(index, { mix: { data: mix, dims: [1, 2, T] }, spec: { data: spec, dims: [1, 4, bins, F] } });
      if (time.data.length !== S * 2 * T || zout.data.length !== S * 4 * plane) throw new Error("The model returned an unexpected shape.");
      return Array.from({ length: S }, (_, s) =>
        [0, 1].map((c) => {
          const at = (s * 4 + 2 * c) * plane;
          const wave = demucsISpec({ re: zout.data.subarray(at, at + plane), im: zout.data.subarray(at + plane, at + 2 * plane), bins, frames: F }, m.nfft, m.hop, T);
          const t = time.data.subarray((s * 2 + c) * T, (s * 2 + c + 1) * T);
          for (let i = 0; i < T; i++) wave[i] += t[i];
          return wave;
        }),
      );
    },
  };
}
