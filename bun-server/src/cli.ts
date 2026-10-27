// Render a photo locally: bun src/cli.ts [--raw] <photo> [out-dir]
// --raw takes the image as pre-dithered (the bot's "sent as a file" path). Writes hokku.bin (panel bytes) and preview.png into out-dir (default: current dir).

import { join } from "node:path";
import { render } from "./render";

const args = process.argv.slice(2);
const raw = args[0] === "--raw";
const [input, outDir = "."] = raw ? args.slice(1) : args;
if (!input) {
  console.error("usage: bun src/cli.ts [--raw] <photo> [out-dir]");
  process.exit(2);
}
const started = performance.now();
const r = await render(new Uint8Array(await Bun.file(input).arrayBuffer()), raw ? "raw" : "photo", {
  cropToFill: Number(process.env.CROP_TO_FILL ?? 1.0),
  squareOrientation: "portrait",
});
await Bun.write(join(outDir, "hokku.bin"), r.panel);
await Bun.write(join(outDir, "preview.png"), r.previewPng);
console.log(`${r.orientation}, ${r.panel.length} bytes, ${Math.round(performance.now() - started)} ms`);
