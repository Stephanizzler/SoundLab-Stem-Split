# SoundLab Stem Split

Read README.md first. Rules come from SoundLab-Core's START_HERE.md and SPEC.md (app id `soundlab.stems`).

- Keep `src/core/` pure TypeScript (no DOM), so `npm test` checks it in Node. Imports use `.ts` extensions.
- `src/core/demucsSpec.ts` and `src/core/separate.ts` mirror Demucs exactly; after changing them run `npm run test:model` (needs `python tools/make_reference.py tests-model/fixtures` with torch + demucs).
- Never overwrite a project version: stems are saved as a new `stems` version with `source.basedOn` and `source.settings`.
- Say honestly what the separation does; show any sample-rate conversion to the user.
