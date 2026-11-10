import { defaultClientConditions, defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Cross-origin isolation lets ONNX Runtime use several CPU threads. Hosts must
// send the same two headers in production (see README, Hosting).
const isolation = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };

export default defineConfig({
  base: "./",
  plugins: [react()],
  // ONNX Runtime's "extern wasm" build loads its WebAssembly glue from a URL we
  // give it (see engine/worker.ts). The default bundled build starts its CPU
  // threads from the bundle's own URL, which after bundling is our worker, and hangs.
  resolve: { conditions: ["onnxruntime-web-use-extern-wasm", ...defaultClientConditions] },
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
});
