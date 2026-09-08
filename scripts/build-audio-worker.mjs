import { build } from "esbuild";

await build({
  entryPoints: ["scripts/audio-worker.ts"], outfile: "build/audio-worker.cjs", bundle: true,
  packages: "external", platform: "node", target: "node24", format: "cjs", logLevel: "warning",
});
