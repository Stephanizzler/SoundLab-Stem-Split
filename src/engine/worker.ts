/// <reference lib="webworker" />
// The separation worker: everything heavy happens here so the page stays responsive.
import * as ort from "onnxruntime-web/webgpu";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import ortGlue from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import { measureLoudness } from "@soundlab/project";
import { demucsSegmentModel } from "../core/demucsModel.ts";
import { manifestProblems } from "../core/manifest.ts";
import { resample } from "../core/resample.ts";
import { separate, shiftOffsets } from "../core/separate.ts";
import { distributeResidual, fromStereo, nullDepthDb, peak, residual, toStereo } from "../core/stems.ts";
import { fetchModelFile } from "./modelFiles.ts";
import type { FromWorker, SeparateRequest, Stage, ToWorker } from "./protocol.ts";

declare const self: DedicatedWorkerGlobalScope;
const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);
let controller: AbortController | null = null;

// ONNX Runtime loads its glue and WebAssembly from these URLs (and starts its CPU threads from the glue).
ort.env.wasm.wasmPaths = { wasm: new URL(ortWasm, self.location.href).href, mjs: new URL(ortGlue, self.location.href).href };
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;

async function hasWebGpu() {
  try { return !!(await (navigator as any).gpu?.requestAdapter()); } catch { return false; }
}

async function run(req: SeparateRequest) {
  const started = performance.now();
  const signal = controller!.signal;
  const issues = manifestProblems(req.manifest);
  if (issues.length) throw new Error(issues[0]);
  const m = req.manifest;
  const progress = (stage: Stage, done: number, total: number, backend?: string) => post({ type: "progress", stage, done, total, backend });

  // 1. Model files (downloaded once, then from the cache).
  const totalBytes = m.files.reduce((n, f) => n + f.bytes, 0);
  const bytes: Uint8Array[] = [];
  let before = 0;
  for (const f of m.files) {
    bytes.push(await fetchModelFile(f, req.modelBase, (n) => progress("download", before + n, totalBytes), signal));
    before += f.bytes;
  }

  // 2. The model's format: stereo at its rate.
  const channelCount = req.channels.length;
  let stereo = toStereo(req.channels);
  if (req.sampleRate !== m.sampleRate) {
    progress("convert-in", 0, 2);
    stereo = stereo.map((ch, i) => { const r = resample(ch, req.sampleRate, m.sampleRate); progress("convert-in", i + 1, 2); return r; });
  }

  // 3. Sessions: WebGPU when the device has it, otherwise WebAssembly on the CPU.
  // Only one model of a bag is held in memory at a time.
  progress("prepare", 0, 1);
  const gpu = await hasWebGpu();
  const backend = gpu ? "WebGPU" : `CPU (${ort.env.wasm.numThreads} thread${ort.env.wasm.numThreads === 1 ? "" : "s"})`;
  let current: { index: number; session: ort.InferenceSession } | null = null;
  const session = async (index: number) => {
    if (current?.index === index) return current.session;
    await current?.session.release();
    current = null;
    const s = await ort.InferenceSession.create(bytes[index], { executionProviders: gpu ? ["webgpu", "wasm"] : ["wasm"], graphOptimizationLevel: "all" });
    current = { index, session: s };
    return s;
  };
  const model = demucsSegmentModel(m, async (index, feeds) => {
    const s = await session(index);
    const r = await s.run({ mix: new ort.Tensor("float32", feeds.mix.data, feeds.mix.dims), spec: new ort.Tensor("float32", feeds.spec.data, feeds.spec.dims) });
    const time = r.time, zout = r.zout;
    const out = { time: { data: (await time.getData()) as Float32Array, dims: time.dims }, zout: { data: (await zout.getData()) as Float32Array, dims: zout.dims } };
    time.dispose(); zout.dispose();
    return out;
  });

  // 4. Separate.
  const est = await separate(stereo, model, {
    shifts: req.shifts, overlap: req.overlap, signal,
    onProgress: (d, t) => progress("separate", d, t, backend),
  });
  await (current as { session: ort.InferenceSession } | null)?.session.release();
  current = null;
  stereo = [];

  // 5. Back to the file's rate and channel layout.
  let stems = est.map((src) => src);
  if (req.sampleRate !== m.sampleRate) {
    const total = stems.length * 2;
    let n = 0;
    stems = stems.map((src) => src.map((ch) => { const r = resample(ch, m.sampleRate, req.sampleRate).subarray(0, req.channels[0].length); progress("convert-out", ++n, total); return r.slice(); }));
  }
  stems = stems.map((src) => fromStereo(src, channelCount));

  // 6. What the stems leave out, then optionally share it out so they add up to the mix.
  progress("measure", 0, stems.length + 1);
  let rest = residual(req.channels, stems);
  const depth = nullDepthDb(req.channels, rest);
  if (req.sumToMix) {
    stems = distributeResidual(stems, rest);
    rest = residual(req.channels, stems);
  }
  const results = stems.map((channels, i) => {
    const loudness = measureLoudness(channels, req.sampleRate);
    progress("measure", i + 1, stems.length + 1);
    return { source: m.sources[i], channels, loudness, peak: peak(channels) };
  });
  const residualLoudness = measureLoudness(rest, req.sampleRate);
  // The stems added together, for a level-matched A/B against the mix.
  const sum = req.channels.map((_, c) => { const x = new Float32Array(req.channels[0].length); for (const s of stems) { const ch = s[c]; for (let i = 0; i < x.length; i++) x[i] += ch[i]; } return x; });
  const sumLoudness = measureLoudness(sum, req.sampleRate);
  post(
    {
      type: "done", stems: results, residual: rest, residualLoudness, sumLoudness,
      nullDepthDb: Number.isFinite(depth) ? depth : null, shiftOffsets: shiftOffsets(req.shifts, m.sampleRate),
      backend, seconds: (performance.now() - started) / 1000,
    },
    [...results.flatMap((r) => r.channels.map((c) => c.buffer)), ...rest.map((c) => c.buffer)],
  );
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  if (e.data.type === "cancel") { controller?.abort(); return; }
  controller = new AbortController();
  try {
    await run(e.data);
  } catch (err) {
    const cancelled = controller.signal.aborted || (err as Error)?.name === "AbortError";
    post({ type: "error", message: cancelled ? "Separation cancelled." : (err as Error)?.message ?? String(err), cancelled });
  } finally {
    controller = null;
  }
};
