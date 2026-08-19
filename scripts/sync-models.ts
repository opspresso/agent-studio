/**
 * Refresh the committed model-catalog snapshot from the published catalog.
 *
 *   pnpm sync-models                  # write src/domain/llm/catalog.json
 *   pnpm sync-models --check          # exit 1 if the snapshot is behind
 *
 * The snapshot is what the unit tests run against and what a boot falls back
 * to when https://models.opspresso.com/models.json cannot be fetched; the
 * running server reads the published catalog itself. So this is run when a
 * test should see a model the catalog gained, or before a release, not on
 * every change agent-models makes. The document is validated the way the
 * runtime validates it — a snapshot the registry could not load would fail
 * every test, and say so here first.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { loadModelCatalog } from "@/domain/llm/models";

const SNAPSHOT = new URL("../src/domain/llm/catalog.json", import.meta.url);
const url = process.env.MODELS_CATALOG_URL ?? "https://models.opspresso.com/models.json";
const check = process.argv.includes("--check");

async function main(): Promise<void> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`GET ${url} → ${response.status} ${response.statusText}`);
  }
  const catalog = (await response.json()) as { updatedAt?: string };
  const report = loadModelCatalog(catalog);
  if (report.skipped.length > 0) {
    console.warn(`! ${report.skipped.length} entries the registry would skip:\n  - ${report.skipped.join("\n  - ")}`);
  }

  const text = `${JSON.stringify(catalog, null, 2)}\n`;
  const current = readFileSync(SNAPSHOT, "utf-8");
  if (current === text) {
    console.log(`snapshot is current (${report.loaded} models, updated ${report.updatedAt})`);
  } else if (check) {
    const was = (JSON.parse(current) as { updatedAt?: string }).updatedAt;
    console.error(`snapshot is behind: ${was} → ${report.updatedAt}; run pnpm sync-models`);
    process.exit(1);
  } else {
    writeFileSync(SNAPSHOT, text);
    console.log(`snapshot written (${report.loaded} models, updated ${report.updatedAt})`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
