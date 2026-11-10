// The description of a separation model that the app downloads, written by
// tools/export_demucs_onnx.py next to the .onnx files.
export type ModelFile = { url: string; bytes: number; sha256: string };
export type ModelManifest = {
  id: string;
  name: string;
  family: "htdemucs";
  licence: string;
  sampleRate: number;
  channels: number;
  segmentSamples: number;
  nfft: number;
  hop: number;
  sources: string[];
  files: ModelFile[];
  weights: number[][];
};

const isNum = (x: unknown) => typeof x === "number" && Number.isFinite(x);
export function manifestProblems(x: unknown): string[] {
  const m = x as ModelManifest, out: string[] = [];
  if (!m || typeof m !== "object") return ["Not a model description."];
  if (typeof m.id !== "string" || !/^[a-z0-9_.-]{1,64}$/.test(m.id) || typeof m.name !== "string") out.push("Model id or name is missing.");
  if (m.family !== "htdemucs") out.push("This app runs Hybrid Transformer Demucs models only.");
  if (!isNum(m.sampleRate) || m.sampleRate < 8000 || m.channels !== 2) out.push("Model audio format is not supported.");
  if (!isNum(m.segmentSamples) || m.segmentSamples < 4096 || m.segmentSamples > 44100 * 60) out.push("Model segment length is not valid.");
  if (m.nfft !== 4096 || m.hop !== 1024) out.push("Model FFT settings are not supported.");
  if (!Array.isArray(m.sources) || !m.sources.length || m.sources.some((s) => typeof s !== "string" || !/^[a-z0-9_]{1,32}$/.test(s))) out.push("Model sources are not valid.");
  if (!Array.isArray(m.files) || !m.files.length || m.files.some((f) => typeof f?.url !== "string" || !isNum(f.bytes) || typeof f.sha256 !== "string"))
    out.push("Model files are not listed correctly.");
  if (!Array.isArray(m.weights) || m.weights.length !== m.files?.length || m.weights.some((w) => !Array.isArray(w) || w.length !== m.sources?.length || w.some((v) => !isNum(v) || v < 0)))
    out.push("Model weights are not valid.");
  else if (m.sources.some((_, s) => m.weights.every((w) => w[s] === 0))) out.push("Every source needs a model that produces it.");
  return out;
}
