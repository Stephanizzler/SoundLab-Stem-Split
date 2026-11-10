// The STFT and inverse STFT of Hybrid Transformer Demucs, done outside the ONNX
// model. Each function matches the Python it names in demucs/htdemucs.py and
// demucs/spec.py (torch.stft / torch.istft with normalized=True, center=True,
// reflect padding, periodic Hann window). tests/demucs-spec.test.mjs checks
// them against values computed by Demucs itself.
import { fft, hann } from "./fft.ts";

// demucs.hdemucs.pad1d with mode="reflect": reflect, but zero-pad first when the
// input is too short to reflect.
export function reflectPad(x: Float32Array, left: number, right: number): Float32Array {
  let src = x, l = left, r = right;
  const maxPad = Math.max(left, right);
  if (x.length <= maxPad) {
    const extra = maxPad - x.length + 1;
    const extraRight = Math.min(right, extra), extraLeft = extra - extraRight;
    src = new Float32Array(x.length + extra);
    src.set(x, extraLeft);
    l = left - extraLeft; r = right - extraRight;
  }
  const n = src.length, out = new Float32Array(n + l + r);
  out.set(src, l);
  for (let i = 0; i < l; i++) out[l - 1 - i] = src[i + 1];
  for (let i = 0; i < r; i++) out[l + n + i] = src[n - 2 - i];
  return out;
}

export type Spec = { re: Float32Array; im: Float32Array; bins: number; frames: number }; // [bins][frames], row-major

// torch.stft(x, nfft, hop, hann, normalized=True, center=True, pad_mode="reflect"), onesided.
export function stft(x: Float32Array, nfft: number, hop: number): Spec {
  const padded = reflectPad(x, nfft / 2, nfft / 2);
  const frames = 1 + Math.floor((padded.length - nfft) / hop), bins = nfft / 2 + 1;
  const w = hann(nfft), scale = 1 / Math.sqrt(nfft);
  const re = new Float32Array(bins * frames), im = new Float32Array(bins * frames);
  const fr = new Float64Array(nfft), fi = new Float64Array(nfft);
  for (let t = 0; t < frames; t++) {
    const at = t * hop;
    for (let i = 0; i < nfft; i++) { fr[i] = padded[at + i] * w[i]; fi[i] = 0; }
    fft(fr, fi);
    for (let k = 0; k < bins; k++) { re[k * frames + t] = fr[k] * scale; im[k * frames + t] = fi[k] * scale; }
  }
  return { re, im, bins, frames };
}

// torch.istft(z, nfft, hop, hann, normalized=True, center=True, length).
export function istft(z: Spec, nfft: number, hop: number, length: number): Float32Array {
  const { bins, frames } = z;
  if (bins !== nfft / 2 + 1) throw new Error("Spectrogram size does not match the FFT size.");
  const w = hann(nfft), scale = Math.sqrt(nfft) / nfft; // undo normalisation, then 1/N of the inverse FFT
  const full = nfft + hop * (frames - 1);
  const out = new Float64Array(full), env = new Float64Array(full);
  const fr = new Float64Array(nfft), fi = new Float64Array(nfft);
  for (let t = 0; t < frames; t++) {
    // Hermitian spectrum; imaginary parts of DC and Nyquist are ignored, as by irfft.
    fr[0] = z.re[t]; fi[0] = 0;
    for (let k = 1; k < bins - 1; k++) {
      const r = z.re[k * frames + t], i = z.im[k * frames + t];
      fr[k] = r; fi[k] = i; fr[nfft - k] = r; fi[nfft - k] = -i;
    }
    fr[nfft / 2] = z.re[(bins - 1) * frames + t]; fi[nfft / 2] = 0;
    fft(fr, fi, true);
    const at = t * hop;
    for (let i = 0; i < nfft; i++) { out[at + i] += fr[i] * scale * w[i]; env[at + i] += w[i] * w[i]; }
  }
  const y = new Float32Array(length), start = nfft / 2;
  for (let i = 0; i < length; i++) {
    const j = start + i;
    y[i] = j < full && env[j] > 1e-11 ? out[j] / env[j] : 0;
  }
  return y;
}

// HTDemucs._spec for one channel, as complex-as-channels input for the model:
// returns real and imaginary planes of [nfft/2 bins][ceil(T/hop) frames].
export function demucsSpec(x: Float32Array, nfft: number, hop: number): Spec {
  if (hop * 4 !== nfft) throw new Error("Demucs uses a hop of a quarter of the FFT size.");
  const le = Math.ceil(x.length / hop), pad = (hop / 2) * 3;
  const z = stft(reflectPad(x, pad, pad + le * hop - x.length), nfft, hop);
  if (z.frames !== le + 4) throw new Error("Unexpected spectrogram length.");
  const bins = nfft / 2, re = new Float32Array(bins * le), im = new Float32Array(bins * le);
  for (let k = 0; k < bins; k++)
    for (let t = 0; t < le; t++) { re[k * le + t] = z.re[k * z.frames + t + 2]; im[k * le + t] = z.im[k * z.frames + t + 2]; }
  return { re, im, bins, frames: le };
}

// HTDemucs._ispec for one channel of one source.
export function demucsISpec(z: Spec, nfft: number, hop: number, length: number): Float32Array {
  const frames = z.frames + 4, bins = z.bins + 1;
  const re = new Float32Array(bins * frames), im = new Float32Array(bins * frames);
  for (let k = 0; k < z.bins; k++)
    for (let t = 0; t < z.frames; t++) { re[k * frames + t + 2] = z.re[k * z.frames + t]; im[k * frames + t + 2] = z.im[k * z.frames + t]; }
  const pad = (hop / 2) * 3, le = hop * Math.ceil(length / hop) + 2 * pad;
  const x = istft({ re, im, bins, frames }, nfft, hop, le);
  return x.slice(pad, pad + length);
}
