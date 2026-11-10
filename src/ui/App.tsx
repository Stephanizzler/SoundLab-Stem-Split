import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BUNDLE_EXTENSION, BUNDLE_MIME, gainToTarget, measureLoudness, owner, readBundle, writeBundle,
  type Loudness, type Project,
} from "@soundlab/project";
import { encodeWav, type WavFormat } from "../core/audiofile.ts";
import type { ModelManifest } from "../core/manifest.ts";
import { browserClock, projectFromFile, relative, saveStems, sha256, splittable, type StemSettings } from "../core/projectio.ts";
import { totalRuns } from "../core/separate.ts";
import { displayOrder, stemName } from "../core/stems.ts";
import { safeFileName, zip } from "../core/zip.ts";
import { resampledLength } from "../core/resample.ts";
import type { FromWorker, Stage, StemResult } from "../engine/protocol.ts";
import { cachedModelBytes } from "../engine/modelFiles.ts";
import { decodeAudio, type OpenedAudio } from "./decode.ts";
import { channelsName, dbToGain, dbtp, eta, khz, lufs, mb, time } from "./format.ts";
import { loadModels, MODEL_BASE } from "./models.ts";
import { Player } from "./player.ts";
import { Waveform } from "./Waveform.tsx";

type Origin =
  | { kind: "file" }
  | { kind: "project"; project: Project; files: Map<string, Uint8Array>; versionId: string; label: string; songTitle: string };
type Source = { fileName: string; title: string; mime: string; bytes: Uint8Array; audio: OpenedAudio; loudness: Loudness | null; origin: Origin };
type Job = { stage: Stage; done: number; total: number; backend?: string; separateStart?: number };
type Result = {
  stems: StemResult[]; residual: Float32Array[]; residualLoudness: Loudness; sumLoudness: Loudness;
  nullDepthDb: number | null; backend: string; seconds: number; settings: StemSettings; model: ModelManifest;
};
type Strip = { mute: boolean; solo: boolean; db: number };
type FormatChoice = "16" | "24" | "32f";

const STEM_COLORS: Record<string, string> = {
  vocals: "#C792EA", drums: "#FF9E64", bass: "#7DCFFF", guitar: "#9ECE6A", piano: "#E0AF68", other: "#A9B1D6", residual: "#8B93A1",
};
const stemColor = (id: string) => STEM_COLORS[id] ?? "#A9B1D6";
const STAGES: Record<Stage, string> = {
  download: "Downloading the model (once; it is kept for next time)",
  prepare: "Starting the model",
  "convert-in": "Converting to the model's sample rate",
  separate: "Separating",
  "convert-out": "Converting the stems back to the file's sample rate",
  measure: "Measuring the stems",
};
const FORMATS: Record<FormatChoice, { label: string; format: WavFormat }> = {
  "16": { label: "16-bit WAV (dithered)", format: { bitDepth: 16, encoding: "pcm" } },
  "24": { label: "24-bit WAV", format: { bitDepth: 24, encoding: "pcm" } },
  "32f": { label: "32-bit float WAV (no clipping)", format: { bitDepth: 32, encoding: "float" } },
};
const defaultFormat = (a: OpenedAudio): FormatChoice => (a.encoding === "float" ? "32f" : a.bitDepth === 16 ? "16" : "24");
const remember = (k: string, v?: string) => { try { if (v === undefined) return localStorage.getItem(k) ?? ""; localStorage.setItem(k, v); } catch { /* private mode */ } return ""; };

function download(bytes: Uint8Array, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function App() {
  const [models, setModels] = useState<ModelManifest[] | null>(null);
  const [modelProblem, setModelProblem] = useState<string>();
  const [modelId, setModelId] = useState("");
  const [cached, setCached] = useState<Record<string, number>>({});
  const [shifts, setShifts] = useState(1);
  const [overlap, setOverlap] = useState(0.25);
  const [sumToMix, setSumToMix] = useState(false);

  const [opening, setOpening] = useState(false);
  const [pending, setPending] = useState<{ project: Project; files: Map<string, Uint8Array>; fileName: string } | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const [strips, setStrips] = useState<Record<string, Strip>>({});
  const [ab, setAb] = useState<"stems" | "mix">("stems");
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [format, setFormat] = useState<FormatChoice>("24");
  const [ownerName, setOwnerName] = useState(() => remember("stemsplit.name"));
  const [memberId, setMemberId] = useState("");
  const [busy, setBusy] = useState(false);

  const worker = useRef<Worker | null>(null);
  const player = useRef<Player | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadModels().then(async ({ models, problem }) => {
      setModels(models); setModelProblem(problem);
      if (models[0]) setModelId(models[0].id);
      const c: Record<string, number> = {};
      for (const m of models) c[m.id] = await cachedModelBytes(m.files, MODEL_BASE);
      setCached(c);
    });
    return () => { worker.current?.terminate(); player.current?.close(); };
  }, []);
  const model = models?.find((m) => m.id === modelId);

  // Playhead.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => { setPos(player.current?.position ?? 0); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const reset = () => {
    worker.current?.terminate(); worker.current = null;
    player.current?.stop(); setPlaying(false); setPos(0);
    setResult(null); setJob(null); setError(undefined); setNotice(undefined);
  };

  const loadSource = useCallback(async (s: Omit<Source, "audio" | "loudness">) => {
    const audio = await decodeAudio(s.bytes);
    if (audio.channels.length > 2) throw new Error(`Stem Split works on mono and stereo files; this one has ${audio.channels.length} channels.`);
    const loudness = measureLoudness(audio.channels, audio.sampleRate);
    reset();
    setPending(null);
    setSource({ ...s, audio, loudness });
    setFormat(defaultFormat(audio));
  }, []);

  const open = async (file: File) => {
    setOpening(true); setError(undefined);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (file.name.toLowerCase().endsWith(BUNDLE_EXTENSION)) {
        const { project, files } = await readBundle(bytes); // checks the format, sizes and checksums
        if (!splittable(project).length) throw new Error("This project has no audio versions to split.");
        setMemberId(owner(project).id);
        reset(); setSource(null);
        setPending({ project, files, fileName: file.name });
      } else {
        await loadSource({ fileName: file.name, title: file.name.replace(/\.[^.]+$/, ""), mime: file.type || "audio/wav", bytes, origin: { kind: "file" } });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOpening(false);
    }
  };

  const pickVersion = async (versionId: string) => {
    if (!pending) return;
    const v = splittable(pending.project).find((x) => x.version.id === versionId)!;
    setOpening(true); setError(undefined);
    try {
      await loadSource({
        fileName: v.asset.name, title: `${v.song.title} ${v.version.label}`, mime: v.asset.mime, bytes: pending.files.get(v.asset.id)!,
        origin: { kind: "project", project: pending.project, files: pending.files, versionId, label: v.version.label, songTitle: v.song.title },
      });
    } catch (e) { setError((e as Error).message); } finally { setOpening(false); }
  };

  const split = () => {
    if (!source || !model) return;
    reset();
    const settings: StemSettings = {
      model: { id: model.id, name: model.name, files: model.files.map((f) => f.sha256) },
      sources: model.sources, shifts, shiftOffsets: [], overlap, sumToMix,
      modelRate: model.sampleRate, fileRate: source.audio.sampleRate,
      output: { bitDepth: 24, encoding: "pcm" }, nullDepthDb: null,
    };
    const w = new Worker(new URL("../engine/worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    setJob({ stage: "download", done: 0, total: 1 });
    w.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.type === "progress") {
        setJob((j) => ({ ...m, separateStart: m.stage === "separate" ? (j?.stage === "separate" ? j.separateStart : performance.now()) : undefined }));
      } else if (m.type === "done") {
        w.terminate(); worker.current = null; setJob(null);
        setCached((c) => ({ ...c, [model.id]: model.files.reduce((n, f) => n + f.bytes, 0) }));
        const r: Result = { ...m, settings: { ...settings, shiftOffsets: m.shiftOffsets, nullDepthDb: m.nullDepthDb }, model };
        setResult(r);
        const s: Record<string, Strip> = { residual: { mute: true, solo: false, db: 0 } };
        for (const st of m.stems) s[st.source] = { mute: false, solo: false, db: 0 };
        setStrips(s); setAb("stems");
        const p = (player.current ??= new Player());
        p.onEnded = () => { setPlaying(false); setPos(0); };
        p.setTracks([
          { id: "mix", channels: source.audio.channels, sampleRate: source.audio.sampleRate },
          ...m.stems.map((st) => ({ id: st.source, channels: st.channels, sampleRate: source.audio.sampleRate })),
          { id: "residual", channels: m.residual, sampleRate: source.audio.sampleRate },
        ]);
      } else {
        w.terminate(); worker.current = null; setJob(null);
        if (!m.cancelled) setError(m.message); else setNotice("Separation cancelled.");
      }
    };
    w.onerror = (e) => { w.terminate(); worker.current = null; setJob(null); setError(e.message || "The separation stopped unexpectedly. The device may have run out of memory."); };
    const channels = source.audio.channels.map((c) => c.slice()); // keep ours for playback
    w.postMessage({ type: "separate", manifest: model, modelBase: MODEL_BASE, channels, sampleRate: source.audio.sampleRate, shifts, overlap, sumToMix }, channels.map((c) => c.buffer));
  };
  const cancel = () => worker.current?.postMessage({ type: "cancel" });

  // Mixer gains: solo wins over mute; A/B swaps the stems for the level-matched mix.
  const matchGain = useMemo(() => (result && source?.loudness ? gainToTarget(source.loudness.integratedLufs, result.sumLoudness.integratedLufs ?? -70) : 1), [result, source]);
  useEffect(() => {
    const p = player.current;
    if (!p || !result) return;
    const anySolo = Object.values(strips).some((s) => s.solo);
    p.setGain("mix", ab === "mix" ? matchGain : 0);
    for (const [id, s] of Object.entries(strips)) {
      const on = anySolo ? s.solo : !s.mute;
      p.setGain(id, ab === "stems" && on ? dbToGain(s.db) : 0);
    }
  }, [strips, ab, result, matchGain]);
  const setStrip = (id: string, patch: Partial<Strip>) => setStrips((s) => ({ ...s, [id]: { ...s[id], ...patch } }));

  const togglePlay = () => {
    const p = player.current;
    if (!p) return;
    if (p.playing) { p.pause(); setPlaying(false); setPos(p.position); } else { void p.play(); setPlaying(true); }
  };
  const seek = (t: number) => { player.current?.seek(t); setPos(t); };

  // Keyboard: space plays/pauses, A/B switches.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!result || (e.target as HTMLElement)?.closest("input, select, textarea, button")) return;
      if (e.code === "Space") { e.preventDefault(); togglePlay(); }
      if (e.key === "b" || e.key === "B") setAb((x) => (x === "mix" ? "stems" : "mix"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Exports.
  const stemFileName = (id: string) => `${safeFileName(source!.title)} - ${stemName(id)}.wav`;
  const encode = (channels: Float32Array[], seed: number) => encodeWav(channels, source!.audio.sampleRate, FORMATS[format].format, seed);
  const clipWarning = (clipped: string[]) =>
    clipped.length ? `${clipped.join(", ")} went over full scale and ${clipped.length === 1 ? "was" : "were"} clipped in ${FORMATS[format].label}. Choose 32-bit float to keep the overs.` : undefined;

  const downloadStem = (id: string) => {
    if (!result || !source) return;
    const channels = id === "residual" ? result.residual : result.stems.find((s) => s.source === id)!.channels;
    const { bytes, clippedSamples } = encode(channels, 1 + result.stems.findIndex((s) => s.source === id));
    download(bytes, stemFileName(id), "audio/wav");
    setNotice(clipWarning(clippedSamples ? [stemName(id)] : []));
  };
  const downloadAll = async () => {
    if (!result || !source) return;
    setBusy(true);
    await new Promise((r) => setTimeout(r, 30));
    try {
      const clipped: string[] = [];
      const files = displayOrder(result.stems.map((s) => s.source)).map((id) => {
        const i = result.stems.findIndex((s) => s.source === id), s = result.stems[i];
        const { bytes, clippedSamples } = encode(s.channels, i + 1);
        if (clippedSamples) clipped.push(stemName(s.source));
        return { name: `${safeFileName(source.title)} stems/${stemFileName(s.source)}`, bytes };
      });
      download(zip(files), `${safeFileName(source.title)} stems.zip`, "application/zip");
      setNotice(clipWarning(clipped));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const saveProject = async () => {
    if (!result || !source) return;
    setBusy(true); setError(undefined);
    await new Promise((r) => setTimeout(r, 30));
    try {
      let project: Project, files: Map<string, Uint8Array>, basedOn: string, createdBy: string;
      if (source.origin.kind === "project") {
        ({ project, files } = source.origin); basedOn = source.origin.versionId; createdBy = memberId || owner(project).id;
      } else {
        const name = ownerName.trim() || "Me";
        remember("stemsplit.name", name);
        const made = projectFromFile(browserClock, {
          title: source.title.slice(0, 120) || "Untitled", ownerName: name, fileName: source.fileName, mime: source.mime, bytes: source.bytes.length,
          audio: { sampleRate: source.audio.sampleRate, channels: source.audio.channels.length, durationSeconds: source.audio.channels[0].length / source.audio.sampleRate, ...(source.loudness ? { loudness: source.loudness } : {}) },
          sha256: await sha256(source.bytes),
        });
        project = made.project; basedOn = made.version.id; createdBy = made.memberId;
        files = new Map([[project.assets[0].id, source.bytes]]);
      }
      const clipped: string[] = [];
      const stems = await Promise.all(result.stems.map(async (s, i) => {
        const { bytes, clippedSamples } = encode(s.channels, i + 1);
        if (clippedSamples) clipped.push(stemName(s.source));
        return {
          source: s.source, name: stemFileName(s.source), bytes, sha256: await sha256(bytes),
          audio: { sampleRate: source.audio.sampleRate, channels: s.channels.length, durationSeconds: s.channels[0].length / source.audio.sampleRate, loudness: s.loudness },
        };
      }));
      const f = FORMATS[format].format;
      const saved = saveStems(project, browserClock, { basedOn, createdBy, stems, settings: { ...result.settings, output: { bitDepth: f.bitDepth, encoding: f.encoding } } });
      const all = new Map(files);
      for (const a of saved.project.assets) if (!all.has(a.id)) all.set(a.id, stems[saved.version.stemIds.indexOf(a.id)].bytes);
      download(writeBundle(saved.project, all), `${safeFileName(saved.project.title)}${BUNDLE_EXTENSION}`, BUNDLE_MIME);
      setNotice([`Saved as ${saved.version.label} in “${saved.project.title}”. Open it in SoundLab CoLab or any SoundLab Pro app.`, clipWarning(clipped)].filter(Boolean).join(" "));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const duration = source ? source.audio.channels[0].length / source.audio.sampleRate : 0;
  const runs = source && model ? totalRuns(model, resampledLength(source.audio.channels[0].length, source.audio.sampleRate, model.sampleRate), { shifts, overlap }) : 0;
  const order = result ? displayOrder(result.stems.map((s) => s.source)) : [];
  const jobEta = job?.stage === "separate" && job.separateStart && job.done > 0 ? ((performance.now() - job.separateStart) / 1000 / job.done) * (job.total - job.done) : NaN;

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && !job) void open(f); }}>
      <header className="top">
        <div>
          <h1>SoundLab <span>Stem Split</span></h1>
          <p className="muted">Split a mix into stems, privately on this device. Nothing is uploaded.</p>
        </div>
        {source && !job && <button className="ghost" onClick={() => fileInput.current?.click()}>Open another file</button>}
      </header>
      <input ref={fileInput} type="file" hidden accept={`audio/*,.wav,.aif,.aiff,.flac,.mp3,.m4a,.ogg,.opus,${BUNDLE_EXTENSION}`}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void open(f); }} />

      {error && <div className="banner bad" role="alert">{error}</div>}
      {notice && <div className="banner" role="status">{notice}</div>}

      {!source && !pending && (
        <button className="drop" onClick={() => fileInput.current?.click()} disabled={opening}>
          <strong>{opening ? "Opening…" : "Open a song"}</strong>
          <span>Drop a WAV, AIFF, FLAC, MP3, M4A or Ogg file, or a SoundLab project (.soundlab).</span>
          <span className="muted">Files are read at their own sample rate and bit depth.</span>
        </button>
      )}

      {pending && !source && (
        <section className="panel">
          <h2 className="label">Choose a version from {pending.project.title}</h2>
          <div className="versions">
            {splittable(pending.project).map(({ song, version, asset }) => (
              <button key={version.id} className="version" onClick={() => void pickVersion(version.id)} disabled={opening}>
                <strong>{song.title} · {version.label}</strong>
                <span className="muted">{asset.audio && `${khz(asset.audio.sampleRate)} · ${channelsName(asset.audio.channels)} · ${time(asset.audio.durationSeconds)}`}{version.stage === "stems" ? " · already stems" : ""}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {source && (
        <section className="panel">
          <div className="row between wrap">
            <div>
              <h2 className="label">Source</h2>
              <div className="title">{source.origin.kind === "project" ? `${source.origin.songTitle} · ${source.origin.label}` : source.fileName}</div>
              <div className="muted small">
                {source.audio.container === "other" ? "Compressed" : source.audio.container.toUpperCase()}
                {source.audio.bitDepth ? ` · ${source.audio.bitDepth}-bit${source.audio.encoding === "float" ? " float" : ""}` : ""}
                {` · ${khz(source.audio.sampleRate)} · ${channelsName(source.audio.channels.length)} · ${time(duration)}`}
              </div>
              {source.audio.note && <div className="warn small">{source.audio.note}</div>}
            </div>
            <div className="readouts">
              <div><span className="label">Loudness</span><span className="readout">{lufs(source.loudness)}</span></div>
              <div><span className="label">True peak</span><span className="readout">{dbtp(source.loudness)}</span></div>
            </div>
          </div>
          {!result && <Waveform channels={source.audio.channels} color="#5B6372" position={0} duration={duration} label="Waveform of the source" height={56} />}
        </section>
      )}

      {source && !result && (
        <section className="panel">
          <h2 className="label">Separation</h2>
          {models === null ? <p className="muted">Looking for models…</p> : !models.length ? (
            <div className="banner">
              <strong>{modelProblem}</strong> Export Demucs with <code>python tools/export_demucs_onnx.py htdemucs public/models</code> (see the README), then reload.
            </div>
          ) : (
            <div className="grid">
              <label>Model
                <select value={modelId} onChange={(e) => setModelId(e.target.value)} disabled={!!job}>
                  {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                {model && <span className="muted small">{model.sources.map(stemName).join(", ")} · {cached[model.id] ? "downloaded" : `${mb(model.files.reduce((n, f) => n + f.bytes, 0))} download, once`}</span>}
              </label>
              <label>Quality
                <select value={shifts} onChange={(e) => setShifts(+e.target.value)} disabled={!!job}>
                  <option value={0}>Draft · 1 pass</option>
                  <option value={1}>Standard · 1 shifted pass</option>
                  <option value={2}>High · 2 passes averaged</option>
                  <option value={5}>Best · 5 passes averaged (slow)</option>
                </select>
                <span className="muted small">More passes smooth out artefacts slightly; time grows with each.</span>
              </label>
              <label>Segment overlap
                <select value={overlap} onChange={(e) => setOverlap(+e.target.value)} disabled={!!job}>
                  <option value={0.1}>10%</option>
                  <option value={0.25}>25% (Demucs default)</option>
                  <option value={0.5}>50%</option>
                </select>
              </label>
              <label className="check">
                <input type="checkbox" checked={sumToMix} onChange={(e) => setSumToMix(e.target.checked)} disabled={!!job} />
                <span>Make the stems add up exactly to the mix<br /><span className="muted small">Shares what the model missed among the stems. Nulls perfectly, but adds a little bleed.</span></span>
              </label>
            </div>
          )}
          {model && !job && (
            <div className="row between wrap actions">
              <span className="muted small">{runs} model runs{model.sampleRate !== source.audio.sampleRate ? ` · runs at ${khz(model.sampleRate)}; stems come back at ${khz(source.audio.sampleRate)}` : ""}{duration > 900 ? " · long files need a lot of memory" : ""}</span>
              <button className="primary" onClick={split}>Split into stems</button>
            </div>
          )}
          {job && (
            <div className="progress" aria-live="polite">
              <div className="row between"><span>{STAGES[job.stage]}{job.stage === "separate" ? ` · ${job.done} of ${job.total}` : ""}</span><span className="muted small">{eta(jobEta)}</span></div>
              <div className="bar"><div style={{ width: `${job.total ? Math.round((job.done / job.total) * 100) : 0}%` }} /></div>
              <div className="row between"><span className="muted small">{job.backend ? `Running on ${job.backend}` : ""}</span><button className="ghost" onClick={cancel}>Cancel</button></div>
            </div>
          )}
        </section>
      )}

      {result && source && (
        <>
          <section className="panel mixer">
            <div className="row between wrap transport">
              <div className="row">
                <button className="primary round" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>{playing ? "❚❚" : "▶"}</button>
                <span className="readout">{time(pos)} <span className="muted">/ {time(duration)}</span></span>
              </div>
              <div className="ab" role="group" aria-label="Compare">
                <button className={ab === "mix" ? "on a" : ""} onClick={() => setAb("mix")}>A · Mix</button>
                <button className={ab === "stems" ? "on b" : ""} onClick={() => setAb("stems")}>B · Stems</button>
              </div>
            </div>
            <p className="muted small">
              A/B is level-matched{source.loudness?.integratedLufs != null && result.sumLoudness.integratedLufs != null ? ` (the mix plays ${Math.abs(20 * Math.log10(matchGain)).toFixed(1)} dB ${matchGain < 1 ? "quieter" : "louder"})` : ""}. Space plays, B switches.
            </p>
            {[...order, "residual"].map((id) => {
              const st = id === "residual" ? null : result.stems.find((s) => s.source === id)!;
              const strip = strips[id];
              if (!strip) return null;
              const anySolo = Object.values(strips).some((s) => s.solo);
              const audible = ab === "stems" && (anySolo ? strip.solo : !strip.mute);
              return (
                <div className={`strip${id === "residual" ? " rest" : ""}`} key={id}>
                  <div className="strip-head">
                    <span className="dot" style={{ background: stemColor(id) }} />
                    <div className="name">
                      <strong>{stemName(id)}</strong>
                      <span className="muted small">{id === "residual" ? (result.nullDepthDb === null ? "nothing missed" : `${result.settings.sumToMix ? "was " : ""}${relative(result.nullDepthDb)}`) : `${lufs(st!.loudness)} · ${dbtp(st!.loudness)}`}</span>
                    </div>
                    <div className="buttons">
                      <button className={strip.mute ? "on mute" : ""} onClick={() => setStrip(id, { mute: !strip.mute })} aria-pressed={strip.mute} title="Mute">M</button>
                      <button className={strip.solo ? "on solo" : ""} onClick={() => setStrip(id, { solo: !strip.solo })} aria-pressed={strip.solo} title="Solo">S</button>
                      <button onClick={() => downloadStem(id)} title={`Download ${stemName(id)}`} aria-label={`Download ${stemName(id)}`}>↓</button>
                    </div>
                  </div>
                  <Waveform channels={st ? st.channels : result.residual} color={stemColor(id)} position={pos} duration={duration} onSeek={seek} dim={!audible} label={`Waveform of ${stemName(id)}`} />
                  <label className="fader">
                    <span className="muted small">{strip.db > 0 ? "+" : ""}{strip.db.toFixed(1)} dB</span>
                    <input type="range" min={-24} max={6} step={0.5} value={strip.db} onChange={(e) => setStrip(id, { db: +e.target.value })} onDoubleClick={() => setStrip(id, { db: 0 })} aria-label={`${stemName(id)} level`} />
                  </label>
                </div>
              );
            })}
            <p className="muted small">
              Remainder is what the stems leave out (the mix minus all stems). Faders and mutes are for listening only; exports are the stems as separated.
            </p>
          </section>

          <section className="panel">
            <h2 className="label">Export</h2>
            <div className="grid">
              <label>Format
                <select value={format} onChange={(e) => setFormat(e.target.value as FormatChoice)}>
                  {Object.entries(FORMATS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
                <span className="muted small">{khz(source.audio.sampleRate)}, {channelsName(source.audio.channels.length)}, same length as the source, so stems line up at zero in any DAW.</span>
              </label>
              {source.origin.kind === "project" ? (
                <label>Saving as
                  <select value={memberId} onChange={(e) => setMemberId(e.target.value)}>
                    {source.origin.project.members.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.role})</option>)}
                  </select>
                </label>
              ) : (
                <label>Your name (for the project)
                  <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} placeholder="Me" maxLength={80} />
                </label>
              )}
            </div>
            <div className="row wrap actions">
              <button className="primary" onClick={downloadAll} disabled={busy}>Download all stems (.zip)</button>
              <button onClick={saveProject} disabled={busy}>{source.origin.kind === "project" ? "Save as new Stems version (.soundlab)" : "Save as SoundLab project (.soundlab)"}</button>
              <button className="ghost" onClick={() => { player.current?.stop(); setPlaying(false); setResult(null); setPos(0); }} disabled={busy}>Split again with other settings</button>
            </div>
            <p className="muted small">
              {result.model.name} · {result.settings.shifts === 0 ? "1 pass" : `${result.settings.shifts} shifted pass${result.settings.shifts > 1 ? "es" : ""}`} · {Math.round(result.settings.overlap * 100)}% overlap · {result.backend} · took {time(result.seconds)}.
              {" "}The settings are saved with the version so it can be redone.
            </p>
          </section>
        </>
      )}

      <footer className="notes">
        <details>
          <summary>What Stem Split does and does not do</summary>
          <ul>
            <li>It estimates each instrument with an AI model (Demucs v4). Results are estimates: expect some bleed between stems, especially reverb, backing vocals and instruments the model was not trained on.</li>
            <li>Everything runs on this device. Your audio is never uploaded.</li>
            <li>Stems keep the source's sample rate and length. The model works at {khz(model?.sampleRate ?? 44100)}; other rates are converted in and out with a high-quality resampler, and the app says so.</li>
            <li>The Remainder strip and its level show honestly how much the stems miss. Saving to a project never changes an existing version: the stems become a new version.</li>
          </ul>
        </details>
      </footer>
    </div>
  );
}
