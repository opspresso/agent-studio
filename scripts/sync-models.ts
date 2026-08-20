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
import { createHttpModelCatalogSource } from "@/infrastructure/llm/modelCatalogHttpSource";
import { config } from "@/lib/config";

const SNAPSHOT = new URL("../src/domain/llm/catalog.json", import.meta.url);
const check = process.argv.includes("--check");

async function main(): Promise<void> {
  // The same source, URL resolution and deadline the runtime refresh uses —
  // a second fetch here is how the two drift on a moved host or a stall.
  const catalog = (await createHttpModelCatalogSource(config.modelsCatalogUrl).load()) as {
    updatedAt?: string;
  };
  const report = loadModelCatalog(catalog);
  if (report.skipped.length > 0) {
    console.warn(`! ${report.skipped.length} entries the registry would skip:\n  - ${report.skipped.join("\n  - ")}`);
  }

  // Freshness is the catalog's own contract — `updatedAt` moves only when the
  // content does — so `--check` compares stamps, not serialisations: a
  // publisher re-ordering keys must not fail CI over identical content.
  const current = JSON.parse(readFileSync(SNAPSHOT, "utf-8")) as { updatedAt?: string };
  if (current.updatedAt === catalog.updatedAt) {
    console.log(`snapshot is current (${report.loaded} models, updated ${report.updatedAt})`);
  } else if (check) {
    console.error(`snapshot is behind: ${current.updatedAt} → ${catalog.updatedAt}; run pnpm sync-models`);
    process.exit(1);
  } else {
    writeFileSync(SNAPSHOT, `${JSON.stringify(catalog, null, 2)}\n`);
    console.log(`snapshot written (${report.loaded} models, updated ${report.updatedAt})`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
