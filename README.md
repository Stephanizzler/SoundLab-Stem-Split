# SoundLab Stem Split

Split a mix into **vocals, drums, bass and other** (or six stems, adding guitar and piano), privately in the browser. Part of the SoundLab Pro family: it opens and saves `.soundlab` projects, so stems go straight on to CoLab, Vocalizer, Mix Assist and Transcribe.

- App id: `soundlab.stems` (see [`docs/APPS.md`](https://github.com/Stephanizzler/SoundLab-Core/blob/main/docs/APPS.md) in SoundLab-Core)
- Built on SoundLab-Core `7bd83cb` (`@soundlab/project`, `@soundlab/design`), pinned in `package.json`

## Decisions (START_HERE §4)

| Question | Decision | Why |
|---|---|---|
| Where processing runs | **In the browser, on the device.** WebGPU when available, otherwise WebAssembly on every CPU core. | Private (audio is never uploaded), works offline after the first model download, no server cost. A server "HQ" mode can be added later as an opt-in. |
| Model | **Demucs v4 (Hybrid Transformer Demucs)** from Meta: `htdemucs` (4 stems), `htdemucs_6s` (6 stems), `htdemucs_ft` (fine-tuned bag, best and 4× slower). | The quality of the stem splitters in today's DAWs; MIT-licensed code. See *Model licences* below before selling. |
| Platform | Web first (React + Vite + TypeScript). | Like the other Pro apps. |

## How it works

1. **Open** a WAV, AIFF, FLAC, MP3, M4A or Ogg file, or a `.soundlab` project (then pick a version). WAV and AIFF are decoded by the app at their own rate and bit depth; compressed files are decoded by the browser at the rate read from their header (the app says if it could not).
2. **Separate** in a Web Worker (`src/engine/worker.ts`). The model runs at 44.1 kHz; other rates are converted in and back out with a high-quality resampler (about 100 dB stopband), and the app shows that it did.
3. **Listen**: every stem plus the **Remainder** (mix minus all stems) play in sync with mute, solo, level and a level-matched **A/B** against the mix. The Remainder's level is an honest measure of what the stems miss.
4. **Export** each stem or all of them as WAV (16-bit dithered, 24-bit or 32-bit float), at the source's rate and exact length so they line up at zero in any DAW. Or **save to a `.soundlab` project**: the stems become a new `Stems` version with `source.basedOn` set to the version they came from, and every setting in `source.settings` so the result can be redone. Nothing already in the project is changed.

### The engine

Demucs' STFT uses complex numbers, which ONNX Runtime Web cannot run, so `tools/export_demucs_onnx.py` exports the network *without* its STFT/iSTFT, and the app does those in TypeScript (`src/core/demucsSpec.ts`). Splitting a song into overlapping segments, the time-shift passes, normalisation and combining a bag of models follow `demucs/apply.py` (`src/core/separate.ts`). Shifts use fixed offsets instead of random ones, so a result can be reproduced exactly.

This is checked against Demucs itself: `npm run test:model` runs a random-weight Demucs bag through the TypeScript pipeline and through Demucs' own `apply_model`, and the outputs agree to within 1e-6.

## Models

Models are not in the repository (80–330 MB each). Export them on any machine with Python:

```sh
pip install torch demucs onnx onnxscript
python tools/export_demucs_onnx.py htdemucs public/models
python tools/export_demucs_onnx.py htdemucs_6s public/models   # optional
python tools/export_demucs_onnx.py htdemucs_ft public/models   # optional
```

Each export writes the `.onnx` file(s), a description with SHA-256 checksums, and adds the model to `public/models/index.json`. The app downloads a model once, checks its checksum, and keeps it in the browser's cache. To host models elsewhere (a CDN or a GitHub release), build with `VITE_MODEL_BASE=https://…/models/`; that host must send CORS headers and `Cross-Origin-Resource-Policy: cross-origin`.

### Model licences: check before selling

- **Code**: Demucs is MIT-licensed, which allows commercial use.
- **Weights**: the pretrained Demucs v4 weights are published with the MIT-licensed repository, but they were trained on MUSDB18-HQ (licensed for non-commercial research) plus Meta's own extra songs. Whether weights trained on such data may be used in a paid product is not settled. **Get legal advice before selling with these weights.** The safe alternative is to train the same architecture (the training code is MIT) on audio you have the rights to, then export it with the same tool.

## Speed

On a 4-core cloud CPU (WebAssembly, 4 threads), a full-size Demucs v4 takes about 4–5 s per 7.8 s segment, roughly 3 minutes for a 3½-minute song at Standard quality. WebGPU is usually several times faster. `htdemucs_ft` takes 4× as long, and each extra quality pass adds one more full run.

## Develop

```sh
pnpm install
pnpm dev            # http://localhost:5173 (sends the cross-origin isolation headers)
pnpm test           # audio maths, file formats, project saving (Node 22.6+)
pnpm run test:model # TypeScript engine vs Demucs (run tools/make_reference.py first; needs torch + demucs)
pnpm build          # static site in dist/
```

### Hosting

It is a static site, published to **GitHub Pages** by `.github/workflows/pages.yml` on every push to `main`: it runs the tests, builds the app, exports the real `htdemucs` model, checks the export against Demucs (`tools/check_export.py`), and deploys. The exported model is cached between runs. One-time setup: *Settings → Pages → Build and deployment → Source: GitHub Actions*.

Test link: https://stephanizzler.github.io/SoundLab-Stem-Split/

For multi-core speed the page must be cross-origin isolated. Hosts that can send headers use `public/_headers` (Netlify, Cloudflare Pages); on GitHub Pages a small service worker (`public/coi-sw.js`) adds them and the page reloads once on the first visit. Model files over 90 MB are served in parts and joined (and checksum-checked) in the browser.

## What works

- Opening WAV (PCM 8–32-bit, float 32/64), AIFF/AIFF-C, and browser-decodable formats at their native rate; `.soundlab` projects, validated with `problems()` and checksums
- Demucs v4 separation in the browser (WebGPU or multi-threaded WebAssembly), with progress, time left and cancel
- 4- and 6-stem models and bags of models (`htdemucs_ft`)
- Quality settings (passes, overlap) and an optional "make the stems add up to the mix"
- Remainder strip with its level; LUFS and true peak for every stem (`measureLoudness`)
- Synced playback with mute, solo, level, seek and level-matched A/B
- WAV export (16/24/32f) with clipping warnings, ZIP of all stems, saving as a new `Stems` version in a `.soundlab` project
- Works at phone width and on desktop

## Not yet

- Only `htdemucs` is published by the workflow; add `htdemucs_6s` / `htdemucs_ft` the same way when wanted
- Phones: the model needs roughly 1 GB of memory while running; older phones may reload the page instead of finishing
- Licence review of the Demucs weights before selling
- Tested in a real browser only with random-weight test models (headless Chromium, CPU); the real weights could not be downloaded in the build environment. Check separation quality and WebGPU speed with the real models on real devices.
- Long files hold every stem in memory; songs over about 15 minutes may run out of memory on phones
- No server "HQ" mode, batch processing, or stem editing (trimming, fades)
- Optional extras for later: export as FLAC or MP3, a "karaoke" two-stem mode (vocals / everything else), a Pro Tools / Logic session template
- Trademark check of "SoundLab" and "Stem Split" before launch
