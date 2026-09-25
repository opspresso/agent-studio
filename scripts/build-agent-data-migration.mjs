import { build } from "esbuild";

await build({
  entryPoints: ["scripts/migrate-agent-data.ts"],
  outfile: "build/migrate-agent-data.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  logLevel: "warning",
});
