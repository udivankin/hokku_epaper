// Render a photo locally: bun src/cli.ts <photo> [out-dir]
// Writes hokku.bin (panel bytes) and preview.png into out-dir (default: current dir).

import { join } from "node:path";
import { renderPhoto } from "./render";

const [input, outDir = "."] = process.argv.slice(2);
if (!input) {
  console.error("usage: bun src/cli.ts <photo> [out-dir]");
  process.exit(2);
}
const started = performance.now();
const r = await renderPhoto(new Uint8Array(await Bun.file(input).arrayBuffer()), {
  cropToFill: Number(process.env.CROP_TO_FILL ?? 1.0),
  squareOrientation: "portrait",
});
await Bun.write(join(outDir, "hokku.bin"), r.panel);
await Bun.write(join(outDir, "preview.png"), r.previewPng);
console.log(`${r.orientation}, ${r.panel.length} bytes, ${Math.round(performance.now() - started)} ms`);
