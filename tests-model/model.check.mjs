// Checks the TypeScript separation pipeline against Demucs itself, using the
// random-weight model and reference output from tools/make_reference.py.
// Needs: python tools/make_reference.py tests-model/fixtures (torch + demucs).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ort from "onnxruntime-node";
import { separate } from "../src/core/separate.ts";
import { demucsSegmentModel } from "../src/core/demucsModel.ts";
import { manifestProblems } from "../src/core/manifest.ts";

const dir = path.join(import.meta.dirname, "fixtures");
if (!fs.existsSync(path.join(dir, "case.json"))) {
  console.log("No reference yet. Run: python tools/make_reference.py tests-model/fixtures");
  process.exit(1);
}
const kase = JSON.parse(fs.readFileSync(path.join(dir, "case.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(dir, kase.manifest), "utf8"));
assert.deepEqual(manifestProblems(manifest), []);
const f32 = (name) => { const b = fs.readFileSync(path.join(dir, name)); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
const input = f32("input.f32"), expected = f32("expected.f32"), n = kase.length;
const sessions = await Promise.all(manifest.files.map((f) => ort.InferenceSession.create(path.join(dir, f.url))));
const model = demucsSegmentModel(manifest, async (i, feeds) => {
  const r = await sessions[i].run({
    mix: new ort.Tensor("float32", feeds.mix.data, feeds.mix.dims),
    spec: new ort.Tensor("float32", feeds.spec.data, feeds.spec.dims),
  });
  return { time: { data: r.time.data, dims: r.time.dims }, zout: { data: r.zout.data, dims: r.zout.dims } };
});
let last = 0;
const t0 = performance.now();
const est = await separate([input.subarray(0, n), input.subarray(n, 2 * n)], model, {
  shifts: kase.shifts, overlap: kase.overlap, onProgress: (d, t) => { last = d; assert.ok(d <= t); },
});
let maxErr = 0, maxRef = 0;
est.forEach((src, s) => src.forEach((ch, c) => {
  const ref = expected.subarray((s * 2 + c) * n, (s * 2 + c + 1) * n);
  for (let i = 0; i < n; i++) { maxErr = Math.max(maxErr, Math.abs(ch[i] - ref[i])); maxRef = Math.max(maxRef, Math.abs(ref[i])); }
}));
console.log(`${last} model runs in ${((performance.now() - t0) / 1000).toFixed(1)} s; max difference ${maxErr.toExponential(2)} (peak ${maxRef.toFixed(3)})`);
assert.ok(maxErr < 1e-4 * Math.max(1, maxRef), "matches Demucs");
console.log("ok: the TypeScript pipeline matches Demucs apply_model");
