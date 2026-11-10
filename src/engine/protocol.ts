// Messages between the page and the separation worker.
import type { Loudness } from "@soundlab/project";
import type { ModelManifest } from "../core/manifest.ts";
import type { Layout, Range } from "../core/arrange.ts";

export type SeparateRequest = {
  type: "separate";
  manifest: ModelManifest;
  modelBase: string; // URL the manifest's file urls are relative to
  channels: Float32Array[]; // the file's own channels, at its own rate (transferred)
  sampleRate: number;
  shifts: number;
  overlap: number;
  sumToMix: boolean;
  layout: Layout;
  range?: Range; // samples at the file's rate; omitted for the whole song
};
export type ToWorker = SeparateRequest | { type: "cancel" };

export type Stage = "download" | "prepare" | "convert-in" | "separate" | "convert-out" | "measure";
export type StemResult = { source: string; channels: Float32Array[]; loudness: Loudness; peak: number };
export type FromWorker =
  | { type: "progress"; stage: Stage; done: number; total: number; backend?: string }
  | { type: "done"; stems: StemResult[]; residual: Float32Array[]; residualLoudness: Loudness; sumLoudness: Loudness; mixLoudness: Loudness; nullDepthDb: number | null; shiftOffsets: number[]; backend: string; seconds: number }
  | { type: "error"; message: string; cancelled: boolean };
