import test from "node:test";
import assert from "node:assert/strict";
import * as P from "@soundlab/project";
import { residual, nullDepthDb, distributeResidual, toStereo, fromStereo, displayOrder } from "../src/core/stems.ts";
import { projectFromFile, saveStems, splittable, sha256, APP_ID } from "../src/core/projectio.ts";
import { manifestProblems } from "../src/core/manifest.ts";
import { clock, sine, maxDiff } from "./helpers.mjs";

test("the remainder is what the stems leave out, and sharing it out makes them null", () => {
  const mix = [sine(44100, 0.2, 200), sine(44100, 0.2, 300)];
  const stems = [mix.map((c) => c.map((v) => v * 0.6)), mix.map((c) => c.map((v) => v * 0.3))];
  const rest = residual(mix, stems);
  assert.ok(Math.abs(nullDepthDb(mix, rest) - 20 * Math.log10(0.1)) < 0.01, "10% left out = -20 dB");
  const fixed = distributeResidual(stems, rest);
  assert.ok(nullDepthDb(mix, residual(mix, fixed)) < -120);
  assert.ok(maxDiff(fixed[0][0], mix[0].map((v) => v * 0.68), 0, 100) < 1e-3, "shared by energy: 0.36 / (0.36 + 0.09) of the remainder");
});

test("mono files give mono stems; more than two channels is refused", () => {
  const m = [Float32Array.of(1, 2)];
  assert.deepEqual(fromStereo(toStereo(m), 1).map((c) => [...c]), [[1, 2]]);
  assert.throws(() => toStereo([m[0], m[0], m[0]]), /3 channels/);
  assert.deepEqual(displayOrder(["other", "bass", "vocals", "drums"]), ["vocals", "drums", "bass", "other"]);
});

test("stems are saved as a new version based on the mix, with their settings", async () => {
  const audio = { sampleRate: 48000, channels: 2, durationSeconds: 3 };
  const made = projectFromFile(clock, { title: "Night Drive", ownerName: "Steph", fileName: "night.wav", mime: "audio/wav", bytes: 100, audio });
  assert.ok(P.isProject(made.project), P.problems(made.project).join("; "));
  const before = JSON.stringify(made.project.songs[0].versions[0]);
  const bytes = new Uint8Array([1, 2, 3]);
  const settings = { model: { id: "htdemucs", name: "Demucs v4 · 4 stems", files: ["abc"] }, sources: ["vocals", "drums"], shifts: 1, shiftOffsets: [11025], overlap: 0.25, sumToMix: false, modelRate: 44100, fileRate: 48000, output: { bitDepth: 24, encoding: "pcm" }, nullDepthDb: -42.3 };
  const r = saveStems(made.project, clock, {
    basedOn: made.version.id, createdBy: made.memberId, settings,
    stems: [{ source: "vocals", name: "Night Drive - Vocals.wav", bytes, audio, sha256: await sha256(bytes) }, { source: "drums", name: "Night Drive - Drums.wav", bytes, audio }],
  });
  assert.ok(P.isProject(r.project), P.problems(r.project).join("; "));
  assert.equal(r.version.label, "Stems 1");
  assert.equal(r.version.stage, "stems");
  assert.equal(r.version.stemIds.length, 2);
  assert.equal(r.version.assetId, made.version.assetId);
  assert.deepEqual(r.version.source, { app: APP_ID, basedOn: made.version.id, settings: { app: APP_ID, schema: 1, data: settings } });
  assert.match(r.version.description, /42.3 dB below the mix/);
  assert.equal(JSON.stringify(r.project.songs[0].versions[0]), before, "the original version is untouched");
  assert.equal(splittable(r.project).length, 2);
  // And it survives a .soundlab file.
  const files = new Map(r.project.assets.map((a) => [a.id, a.kind === "audio" ? new Uint8Array(100) : bytes]));
  const back = await P.readBundle(P.writeBundle(r.project, files));
  assert.deepEqual(back.project, r.project);
  assert.throws(() => saveStems(made.project, clock, { basedOn: "nope", createdBy: made.memberId, stems: [], settings }), /not in the project/);
});

test("model descriptions are checked before use", () => {
  const good = { id: "htdemucs", name: "x", family: "htdemucs", licence: "MIT", sampleRate: 44100, channels: 2, segmentSamples: 343980, nfft: 4096, hop: 1024, sources: ["drums", "bass"], files: [{ url: "a.onnx", bytes: 1, sha256: "x" }], weights: [[1, 1]] };
  assert.deepEqual(manifestProblems(good), []);
  assert.match(manifestProblems({ ...good, weights: [[1, 0]] }).join(), /Every source/);
  assert.match(manifestProblems({ ...good, nfft: 2048 }).join(), /FFT/);
  assert.match(manifestProblems(null).join(), /Not a model/);
});

test("the stems ZIP opens with standard tools", async () => {
  const { zip, safeFileName } = await import("../src/core/zip.ts");
  const z = zip([{ name: "a/Vocals.wav", bytes: new Uint8Array([1, 2, 3]) }, { name: "Drums.wav", bytes: new Uint8Array(0) }]);
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zip-")), "s.zip");
  fs.writeFileSync(file, z);
  const listing = execFileSync("python3", ["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print([(i.filename,i.file_size) for i in z.infolist()])", file]).toString();
  assert.match(listing, /'a\/Vocals.wav', 3\).*'Drums.wav', 0/);
  assert.equal(safeFileName('Mix: "final"/v2'), "Mix- -final-v2");
});

test("model files served in parts must add up", () => {
  const base = { id: "htdemucs", name: "x", family: "htdemucs", licence: "MIT", sampleRate: 44100, channels: 2, segmentSamples: 343980, nfft: 4096, hop: 1024, sources: ["drums"], weights: [[1]] };
  const file = { url: "a.onnx", bytes: 10, sha256: "x" };
  assert.deepEqual(manifestProblems({ ...base, files: [{ ...file, parts: [{ url: "a.onnx.part0", bytes: 6 }, { url: "a.onnx.part1", bytes: 4 }] }] }), []);
  assert.match(manifestProblems({ ...base, files: [{ ...file, parts: [{ url: "a.onnx.part0", bytes: 6 }] }] }).join(), /add up/);
});
