// Node strips TypeScript types from our own files but not from node_modules.
// The SoundLab-Core packages are plain TypeScript source, so strip them here.
import { register } from "node:module";
register("./ts-in-node-modules.mjs", import.meta.url);
