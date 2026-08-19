/**
 * Keeping the model registry current with the catalog agent-models publishes.
 *
 * The registry starts as the committed snapshot (`domain/llm/models.ts`
 * loads it at evaluation). This refreshes it: once at boot, awaited so the
 * first request prices against today's catalog rather than the snapshot's,
 * and then on an interval, since the catalog changes daily and a long-lived
 * process would otherwise drift until its next deploy.
 *
 * A refresh that fails — the site unreachable, a document that is not a
 * catalog — leaves the registry as it was and says so. The snapshot is a
 * working registry; a process that refused to boot because a static site was
 * down would be trading a stale price for no service.
 */

import { loadModelCatalog, type ModelCatalogLoadReport } from "@/domain/llm/models";
import type { ModelCatalogSource } from "@/domain/llm/modelCatalogSource";
import { log } from "@/shared/logger";

export interface ModelCatalogRefresher {
  /** Fetch and install once; false when the registry was left as it was. */
  refresh(): Promise<boolean>;
  /** Refresh on the interval until `stop()`; a second call is a no-op. */
  start(): void;
  stop(): void;
}

export interface ModelCatalogRefreshDeps {
  source: ModelCatalogSource;
  /** 0 disables the interval; the boot refresh still runs. */
  intervalMs: number;
}

export function createModelCatalogRefresher(deps: ModelCatalogRefreshDeps): ModelCatalogRefresher {
  let timer: ReturnType<typeof setInterval> | undefined;

  async function refresh(): Promise<boolean> {
    let report: ModelCatalogLoadReport;
    try {
      report = loadModelCatalog(await deps.source.load());
    } catch (error) {
      log.warn(
        "models",
        `model catalog not refreshed from ${deps.source.description}; the registry keeps what it had — ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    const skipped = report.skipped.length > 0 ? `, ${report.skipped.length} skipped: ${report.skipped.join("; ")}` : "";
    log.info("models", `model catalog loaded from ${deps.source.description}: ${report.loaded} models (updated ${report.updatedAt})${skipped}`);
    return true;
  }

  return {
    refresh,
    start() {
      if (timer !== undefined || deps.intervalMs <= 0) {
        return;
      }
      timer = setInterval(() => {
        void refresh();
      }, deps.intervalMs);
      // A refresh loop must not keep a process alive that is otherwise done.
      timer.unref?.();
    },
    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
