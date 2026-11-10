import { manifestProblems, type ModelManifest } from "../core/manifest.ts";

// Where models are served from: VITE_MODEL_BASE at build time, or ./models/ next to the app.
export const MODEL_BASE = new URL(import.meta.env.VITE_MODEL_BASE || "models/", document.baseURI).href;

export async function loadModels(): Promise<{ models: ModelManifest[]; problem?: string }> {
  let index: unknown;
  try {
    const r = await fetch(new URL("index.json", MODEL_BASE), { cache: "no-cache" });
    if (!r.ok) return { models: [], problem: "No separation models are installed yet." };
    index = await r.json();
  } catch {
    return { models: [], problem: "No separation models are installed yet." };
  }
  if (!Array.isArray(index)) return { models: [], problem: "The model list is damaged." };
  const models: ModelManifest[] = [];
  for (const name of index.slice(0, 20)) {
    if (typeof name !== "string" || !/^[\w.-]+\.json$/.test(name)) continue;
    try {
      const m = await (await fetch(new URL(name, MODEL_BASE))).json();
      if (!manifestProblems(m).length) models.push(m);
    } catch { /* skip a model whose description is missing */ }
  }
  return models.length ? { models } : { models, problem: "None of the listed models could be loaded." };
}
