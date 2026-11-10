import test from "node:test";
import assert from "node:assert/strict";
import { fft } from "../src/core/fft.ts";
import { demucsSpec, demucsISpec, stft, istft, reflectPad } from "../src/core/demucsSpec.ts";
import { fixture, maxDiff } from "./helpers.mjs";

test("FFT matches a direct DFT", () => {
  const n = 64, re = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.3) + (i % 5) / 7), im = new Float64Array(n);
  const want = Array.from({ length: n }, (_, k) => {
    let r = 0, j = 0;
    for (let i = 0; i < n; i++) { r += re[i] * Math.cos((2 * Math.PI * k * i) / n); j -= re[i] * Math.sin((2 * Math.PI * k * i) / n); }
    return [r, j];
  });
  const r2 = re.slice(), i2 = im.slice();
  fft(r2, i2);
  for (let k = 0; k < n; k++) { assert.ok(Math.abs(r2[k] - want[k][0]) < 1e-9); assert.ok(Math.abs(i2[k] - want[k][1]) < 1e-9); }
  fft(r2, i2, true);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(r2[i] / n - re[i]) < 1e-12, "inverse undoes forward");
});

test("reflect padding matches torch, including inputs shorter than the padding", () => {
  assert.deepEqual([...reflectPad(Float32Array.of(1, 2, 3, 4), 2, 3)], [3, 2, 1, 2, 3, 4, 3, 2, 1]);
  // demucs pad1d: too short to reflect, so zeros are added first.
  assert.equal(reflectPad(Float32Array.of(1, 2), 3, 3).length, 8);
});

test("STFT then inverse STFT gives back the signal", () => {
  const x = Float32Array.from({ length: 10000 }, (_, i) => Math.sin(i * 0.01) * Math.cos(i * 0.0007));
  const y = istft(stft(x, 4096, 1024), 4096, 1024, x.length);
  assert.ok(maxDiff(x, y) < 1e-5);
});

test("spectrogram matches HTDemucs._spec (values from Demucs)", () => {
  const x = fixture("spec-x.f32"), z = fixture("spec-z.f32");
  const s = demucsSpec(x, 4096, 1024);
  assert.equal(s.bins, 2048); assert.equal(s.frames, 5);
  assert.ok(maxDiff(s.re, z.subarray(0, s.re.length)) < 2e-6);
  assert.ok(maxDiff(s.im, z.subarray(s.re.length)) < 2e-6);
});

test("inverse spectrogram matches HTDemucs._ispec (values from Demucs)", () => {
  const z = fixture("ispec-z.f32"), y = fixture("ispec-y.f32"), plane = 2048 * 5;
  const out = demucsISpec({ re: z.subarray(0, plane), im: z.subarray(plane), bins: 2048, frames: 5 }, 4096, 1024, 5000);
  assert.ok(maxDiff(out, y) < 2e-6);
});
