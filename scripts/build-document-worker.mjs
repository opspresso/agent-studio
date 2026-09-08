import { build } from "esbuild";

// Bundle the worker's dependencies so standalone deployments need no runtime package manager.
await build({
  entryPoints: ["src/infrastructure/documents/workerEntry.ts"],
  outfile: "build/document-worker.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  sourcemap: false,
  logLevel: "warning",
});
