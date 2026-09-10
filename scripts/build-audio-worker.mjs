import { build } from "esbuild";

await build({
  entryPoints: ["scripts/audio-worker.ts"], outfile: "build/audio-worker.cjs", bundle: true,
  // Next.js may inline these packages into the HTTP server instead of copying
  // them to standalone/node_modules. The independent worker needs its own bundle.
  platform: "node", target: "node24", format: "cjs", logLevel: "warning",
});
