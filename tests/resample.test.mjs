import test from "node:test";
import assert from "node:assert/strict";
import { resample, resampledLength } from "../src/core/resample.ts";
import { sine, db } from "./helpers.mjs";

const rms = (x, from, to) => { let e = 0; for (let i = from; i < to; i++) e += x[i] * x[i]; return Math.sqrt(e / (to - from)); };

test("a 1 kHz tone survives 48 → 44.1 → 48 kHz with more than 90 dB to spare", () => {
  const x = sine(48000, 1, 1000, 0.5);
  const y = resample(x, 48000, 44100);
  assert.equal(y.length, resampledLength(x.length, 48000, 44100));
  const back = resample(y, 44100, 48000);
  const err = Float32Array.from(x, (v, i) => v - back[i]);
  const ratio = rms(err, 2000, 46000) / rms(x, 2000, 46000);
  assert.ok(db(ratio) < -90, `error ${db(ratio).toFixed(1)} dB`);
});

test("level is kept at 15 kHz and content above the new Nyquist is removed", () => {
  const pass = resample(sine(96000, 0.5, 15000, 0.5), 96000, 44100);
  assert.ok(Math.abs(db(rms(pass, 2000, 20000) / (0.5 / Math.SQRT2))) < 0.05, "flat passband");
  const alias = resample(sine(96000, 0.5, 30000, 0.5), 96000, 44100);
  assert.ok(db(rms(alias, 2000, 20000) / (0.5 / Math.SQRT2)) < -90, "stopband");
});

test("DC passes unchanged and equal rates copy", () => {
  const y = resample(new Float32Array(5000).fill(0.25), 44100, 48000);
  assert.ok(Math.abs(y[2500] - 0.25) < 1e-6);
  const x = Float32Array.of(1, 2, 3);
  assert.deepEqual([...resample(x, 44100, 44100)], [1, 2, 3]);
});
