import { stripTypeScriptTypes } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function load(url, context, next) {
  if (url.includes("/node_modules/") && url.includes("/@soundlab/") && url.endsWith(".ts")) {
    const source = await readFile(fileURLToPath(url), "utf8");
    return { format: "module", source: stripTypeScriptTypes(source), shortCircuit: true };
  }
  return next(url, context);
}
