import { build } from "esbuild";

await build({
  entryPoints: ["scripts/workspace-worker.ts"], outfile: "build/workspace-worker.cjs", bundle: true,
  platform: "node", target: "node24", format: "cjs", logLevel: "warning",
});
