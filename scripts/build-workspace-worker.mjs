import { build } from "esbuild";

await build({
  entryPoints: ["scripts/workspace-worker.ts", "scripts/workspace-health.ts"], outdir: "build", outExtension: { ".js": ".cjs" }, bundle: true,
  platform: "node", target: "node24", format: "cjs", logLevel: "warning",
});
