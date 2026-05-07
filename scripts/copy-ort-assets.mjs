#!/usr/bin/env node
/**
 * Copy onnxruntime-web's WASM helper files to public/onnxruntime-web/ so the
 * server runtime can load them via a local file:// URL. Avoids Node's
 * ERR_UNSUPPORTED_ESM_URL_SCHEME when ORT tries to dynamic-import from CDNs.
 *
 * Run automatically by `npm run build` (and dev via predev hook).
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const SRC = path.resolve("node_modules/onnxruntime-web/dist");
const DST = path.resolve("public/onnxruntime-web");

await fs.mkdir(DST, { recursive: true });
const files = await fs.readdir(SRC);
let copied = 0;
for (const f of files) {
  if (f.endsWith(".wasm") || f.endsWith(".mjs")) {
    await fs.copyFile(path.join(SRC, f), path.join(DST, f));
    copied++;
  }
}
console.log(`[ort-assets] copied ${copied} files to ${DST}`);
