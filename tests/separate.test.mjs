import test from "node:test";
import assert from "node:assert/strict";
import { separate, totalRuns, shiftOffsets } from "../src/core/separate.ts";
import { maxDiff } from "./helpers.mjs";

// A pretend model that hands back fixed fractions of its input: the blended
// result must then be exactly those fractions of the song, at every join.
function fractionModel(fractions, segment = 1000, weights = [fractions.map(() => 1)]) {
  let runs = 0;
  return {
    sources: fractions.map((_, i) => `s${i}`), sampleRate: 4000, segmentSamples: segment, weights,
    get runs() { return runs; },
    async run(_m, seg) { runs++; assert.equal(seg[0].length, segment); return fractions.map((f) => seg.map((ch) => ch.map((v) => v * f))); },
  };
}
const song = (n) => [Float32Array.from({ length: n }, (_, i) => Math.sin(i / 7) * 0.5 + 0.1), Float32Array.from({ length: n }, (_, i) => Math.cos(i / 11) * 0.3)];

test("segments blend back seamlessly, with and without shifts", async () => {
  const mix = song(4321);
  for (const shifts of [0, 1, 3])
    for (const overlap of [0, 0.25, 0.5]) {
      const model = fractionModel([0.5, 0.25, 0.25]);
      let done = 0, total = 0;
      const out = await separate(mix, model, { shifts, overlap, onProgress: (d, t) => { done = d; total = t; } });
      assert.equal(done, total, "progress reaches the end");
      assert.equal(model.runs, totalRuns(model, mix[0].length, { shifts, overlap }), "run count is predicted exactly");
      // Normalisation adds the mean back to every source (as Demucs does), so compare without it.
      const meanOf = (x) => (x[0].reduce((a, b) => a + b, 0) + x[1].reduce((a, b) => a + b, 0)) / (2 * x[0].length);
      const mean = meanOf(mix);
      out.forEach((src, s) => src.forEach((ch, c) => {
        const want = mix[c].map((v) => (v - mean) * [0.5, 0.25, 0.25][s] + mean);
        assert.ok(maxDiff(ch, want) < 1e-5, `shifts ${shifts} overlap ${overlap}`);
      }));
    }
});

test("a bag of models is weighted per source", async () => {
  const mix = song(2500);
  // Each model gets one source right (fraction 1) and one wrong (0.2 / 0.3).
  const a = fractionModel([1, 0.3]), b = fractionModel([0.2, 1]);
  const mean = (mix[0].reduce((x, y) => x + y) + mix[1].reduce((x, y) => x + y)) / 5000;
  const bag = { ...a, weights: [[1, 0], [0, 1]], run: (m, seg) => (m === 0 ? a : b).run(m, seg) };
  let out = await separate(mix, bag, { shifts: 0, overlap: 0.25 });
  assert.ok(maxDiff(out[0][0], mix[0]) < 1e-5, "first source comes only from the first model");
  assert.ok(maxDiff(out[1][1], mix[1]) < 1e-5, "second source comes only from the second model");
  // Equal weights average the two models.
  out = await separate(mix, { ...bag, weights: [[1, 1], [1, 1]] }, { shifts: 0, overlap: 0.25 });
  assert.ok(maxDiff(out[0][0], mix[0].map((v) => (v - mean) * 0.6 + mean)) < 1e-5);
});

test("songs shorter than one segment work", async () => {
  const out = await separate(song(300), fractionModel([1]), { shifts: 1, overlap: 0.25 });
  assert.equal(out[0][0].length, 300);
});

test("cancelling stops the work", async () => {
  const ctrl = new AbortController(), model = fractionModel([1]);
  const run = model.run;
  model.run = async (...a) => { ctrl.abort(); return run(...a); };
  await assert.rejects(separate(song(5000), model, { shifts: 0, overlap: 0.25, signal: ctrl.signal }), /cancelled/);
});

test("shift offsets are repeatable and inside half a second", () => {
  assert.deepEqual(shiftOffsets(2, 44100), [5512, 16537]);
  for (const o of shiftOffsets(5, 44100)) assert.ok(o >= 0 && o <= 22050);
});

test("bad settings are refused", async () => {
  await assert.rejects(separate([new Float32Array(10)], fractionModel([1]), { shifts: 0, overlap: 0.25 }), /stereo/);
  await assert.rejects(separate(song(10), fractionModel([1]), { shifts: 0, overlap: 1 }), /Overlap/);
});
