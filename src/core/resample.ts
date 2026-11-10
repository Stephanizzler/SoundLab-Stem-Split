// High-quality sample-rate conversion (rational polyphase, Kaiser-windowed
// sinc, about 100 dB stopband, passband flat to 95% of the lower Nyquist).
// Used to bring audio to the model's rate and the stems back to the file's rate.

function bessel0(x: number) {
  let sum = 1, term = 1;
  for (let k = 1; k < 50; k++) { term *= (x / (2 * k)) ** 2; sum += term; if (term < 1e-12 * sum) break; }
  return sum;
}
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

export const RESAMPLER = { zeros: 32, beta: 10, rolloff: 0.95 } as const;

export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (!(from > 0 && to > 0 && Number.isInteger(from) && Number.isInteger(to))) throw new Error("Sample rates must be whole numbers of hertz.");
  if (from === to) return x.slice();
  const g = gcd(from, to), up = to / g, down = from / g;
  const outLength = Math.ceil((x.length * up) / down);
  // Kernel in input-sample units: cutoff fc (cycles per input sample), half-width in input samples.
  const fc = 0.5 * Math.min(1, up / down) * RESAMPLER.rolloff;
  const half = Math.ceil(RESAMPLER.zeros / (2 * fc)), i0 = bessel0(RESAMPLER.beta);
  const taps = 2 * half;
  const kernel = (tau: number) => {
    const r = tau / half;
    if (Math.abs(r) >= 1) return 0;
    const s = tau === 0 ? 1 : Math.sin(2 * Math.PI * fc * tau) / (2 * Math.PI * fc * tau);
    return 2 * fc * s * (bessel0(RESAMPLER.beta * Math.sqrt(1 - r * r)) / i0);
  };
  // One set of taps per output phase; each phase sums to exactly 1 so DC passes unchanged.
  const phaseTable = up <= 4096 ? new Float32Array(up * taps) : null;
  const tapsFor = (phase: number, into: Float32Array, at: number) => {
    const frac = phase / up; // output time minus floor, in input samples
    let sum = 0;
    for (let k = 0; k < taps; k++) { const val = kernel(frac - (k - half + 1)); into[at + k] = val; sum += val; }
    for (let k = 0; k < taps; k++) into[at + k] /= sum;
  };
  if (phaseTable) for (let ph = 0; ph < up; ph++) tapsFor(ph, phaseTable, ph * taps);
  const scratch = new Float32Array(taps), out = new Float32Array(outLength), n = x.length;
  for (let m = 0; m < outLength; m++) {
    const num = m * down, base = Math.floor(num / up), phase = num - base * up;
    let h: Float32Array, at = 0;
    if (phaseTable) { h = phaseTable; at = phase * taps; } else { tapsFor(phase, scratch, 0); h = scratch; }
    let acc = 0;
    const first = base - half + 1;
    if (first >= 0 && first + taps <= n) for (let k = 0; k < taps; k++) acc += h[at + k] * x[first + k];
    else for (let k = 0; k < taps; k++) { const i = first + k; if (i >= 0 && i < n) acc += h[at + k] * x[i]; }
    out[m] = acc;
  }
  return out;
}

// The number of samples a signal of `length` has after conversion.
export const resampledLength = (length: number, from: number, to: number) => (from === to ? length : Math.ceil((length * to) / from));
