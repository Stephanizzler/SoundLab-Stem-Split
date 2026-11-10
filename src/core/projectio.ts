// Saving stems into a SoundLab project, following SPEC.md in SoundLab-Core:
// the stems become a new "Stems" version based on the version they came from;
// nothing that was already in the project is changed.
import {
  addAsset, addSong, addVersion, createProject, findVersion, findAsset,
  type AudioInfo, type Clock, type Project, type Version,
} from "@soundlab/project";

export const APP_ID = "soundlab.stems" as const;
export const SETTINGS_SCHEMA = 1;

// Everything needed to redo or adjust a separation (source.settings.data).
export type StemSettings = {
  model: { id: string; name: string; files: string[] }; // files: sha256 of each ONNX file
  sources: string[];
  shifts: number;
  shiftOffsets: number[];
  overlap: number;
  sumToMix: boolean;
  modelRate: number; // the rate the model ran at
  fileRate: number; // the rate of the source file and of the stems
  output: { bitDepth: number; encoding: "pcm" | "float" };
  nullDepthDb: number | null; // remainder below the mix before any sum-to-mix step; null for digital silence
};

// "42.3 dB below the mix" / "0.1 dB above the mix".
export const relative = (db: number) => `${Math.abs(db).toFixed(1)} dB ${db <= 0 ? "below" : "above"} the mix`;

export type StemFile = { source: string; name: string; bytes: Uint8Array; audio: AudioInfo; sha256?: string };

export async function sha256(bytes: Uint8Array) {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A loose audio file becomes a project with one song and one mix version, so the stems have something to be based on.
export function projectFromFile(c: Clock, o: { title: string; ownerName: string; fileName: string; mime: string; bytes: number; audio: AudioInfo; sha256?: string }) {
  let project = createProject(c, o.title, { name: o.ownerName });
  const me = project.members[0].id;
  const s = addSong(project, c, o.title); project = s.project;
  const a = addAsset(project, c, { kind: "audio", name: o.fileName, mime: o.mime, bytes: o.bytes, audio: o.audio, ...(o.sha256 ? { sha256: o.sha256 } : {}), createdBy: me }); project = a.project;
  const v = addVersion(project, c, s.song.id, {
    stage: "mix", assetId: a.asset.id, createdBy: me, description: "Imported into SoundLab Stem Split.", source: { app: APP_ID },
  });
  return { project: v.project, songId: s.song.id, version: v.version, memberId: me };
}

export function saveStems(p: Project, c: Clock, o: { basedOn: string; createdBy: string; stems: StemFile[]; settings: StemSettings; description?: string }): { project: Project; version: Version } {
  const found = findVersion(p, o.basedOn);
  if (!found) throw new Error("The version these stems came from is not in the project.");
  if (!o.stems.length) throw new Error("There are no stems to save.");
  let project = p;
  const ids: string[] = [];
  for (const s of o.stems) {
    const r = addAsset(project, c, { kind: "stem", name: s.name, mime: "audio/wav", bytes: s.bytes.length, audio: s.audio, ...(s.sha256 ? { sha256: s.sha256 } : {}), createdBy: o.createdBy });
    project = r.project; ids.push(r.asset.id);
  }
  const db = o.settings.nullDepthDb;
  const description = o.description ?? [
    `${o.stems.length} stems (${o.stems.map((s) => s.source).join(", ")}) split from ${found.version.label} with ${o.settings.model.name} in SoundLab Stem Split.`,
    "AI estimates: some bleed between stems is normal.",
    db === null ? "" : o.settings.sumToMix ? `What the stems missed (${relative(db)}) was shared out so they add up to the mix.` : `What the stems miss (the mix minus all stems) is ${relative(db)}.`,
  ].filter(Boolean).join(" ");
  return addVersion(project, c, found.song.id, {
    stage: "stems",
    assetId: found.version.assetId, // the listening file is the mix the stems were split from
    stemIds: ids,
    createdBy: o.createdBy,
    description,
    source: { app: APP_ID, basedOn: o.basedOn, settings: { app: APP_ID, schema: SETTINGS_SCHEMA, data: o.settings } },
  });
}

// Versions in a project that have audio this app can split.
export function splittable(p: Project) {
  return p.songs.flatMap((s) => s.versions.filter((v) => findAsset(p, v.assetId)?.audio).map((v) => ({ song: s, version: v, asset: findAsset(p, v.assetId)! })));
}

export const browserClock: Clock = { now: () => new Date().toISOString(), id: () => crypto.randomUUID() };
