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

import {
  loadModelCatalog,
  loadSelfHostedModels,
  modelCatalogUpdatedAt,
  type ModelCatalogLoadReport,
} from "@/domain/llm/models";
import type { ModelCatalogSource } from "@/domain/llm/modelCatalogSource";
import { log } from "@/shared/logger";
import { unrefTimer } from "@/shared/unrefTimer";

/** How many skipped/removed ids a log line names before counting the rest. */
const REPORT_SAMPLE = 5;

function sample(items: string[]): string {
  const shown = items.slice(0, REPORT_SAMPLE).join("; ");
  return items.length > REPORT_SAMPLE ? `${shown}; +${items.length - REPORT_SAMPLE} more` : shown;
}

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
  /**
   * The deployment's self-hosted declarations, when it has any — re-read and
   * re-installed on every refresh, right *after* the catalog step, because
   * declaration validation reads the current catalog (one story per family
   * across both publishers) and because a settings write on another instance
   * is otherwise invisible to this process until it reboots.
   */
  localModels?: () => Promise<unknown>;
}

export function createModelCatalogRefresher(deps: ModelCatalogRefreshDeps): ModelCatalogRefresher {
  let timer: ReturnType<typeof setInterval> | undefined;
  /** The refresh in flight, so a slow fetch and the next tick cannot interleave installs. */
  let inFlight: Promise<boolean> | undefined;

  async function refreshOnce(): Promise<boolean> {
    const installed = await refreshCatalog();
    // After the catalog step even when it installed nothing: declaration
    // validation reads the current catalog, and the declarations may have
    // changed while the catalog did not.
    await refreshLocalModels();
    return installed;
  }

  /** Re-install the deployment's declarations; a failure keeps the overlay as it was. */
  async function refreshLocalModels(): Promise<void> {
    if (deps.localModels === undefined) {
      return;
    }
    try {
      const report = loadSelfHostedModels((await deps.localModels()) ?? []);
      // Quiet in the steady state, loud on loss: a skipped declaration is a
      // model the operator declared and a run cannot use.
      if (report.skipped.length > 0) {
        log.warn(
          "models",
          `self-hosted declarations: ${report.skipped.length} skipped — ${sample(report.skipped)} (${report.loaded} installed)`,
        );
      } else if (report.removed.length > 0) {
        log.info(
          "models",
          `self-hosted declarations installed: ${report.loaded} model(s), removed ${sample(report.removed)}`,
        );
      }
    } catch (error) {
      log.warn(
        "models",
        `self-hosted declarations not refreshed; the overlay keeps what it had — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function refreshCatalog(): Promise<boolean> {
    let document: unknown;
    try {
      document = await deps.source.load();
    } catch (error) {
      log.warn(
        "models",
        `model catalog not refreshed from ${deps.source.description}; the registry keeps what it had — ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    // `updatedAt` moves only when the content does (agent-models' contract),
    // so an equal stamp is the quiet hourly case — no reinstall, no log line —
    // and an older one is a stale read (a lagging CDN node) that must not
    // roll the registry back.
    const incoming = (document as { updatedAt?: unknown } | null)?.updatedAt;
    const current = modelCatalogUpdatedAt();
    if (typeof incoming === "string" && current !== "" && incoming <= current) {
      if (incoming < current) {
        log.warn(
          "models",
          `model catalog from ${deps.source.description} is older than the registry (${incoming} < ${current}); keeping the newer one`,
        );
      }
      return false;
    }
    let report: ModelCatalogLoadReport;
    try {
      report = loadModelCatalog(document);
    } catch (error) {
      log.warn(
        "models",
        `model catalog not refreshed from ${deps.source.description}; the registry keeps what it had — ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    const skipped =
      report.skipped.length > 0 ? `, ${report.skipped.length} skipped: ${sample(report.skipped)}` : "";
    log.info(
      "models",
      `model catalog loaded from ${deps.source.description}: ${report.loaded} models (updated ${report.updatedAt})${skipped}`,
    );
    if (report.removed.length > 0) {
      // agent-models retires by hiding; an id that vanished outright now
      // books any stored version's usage at $0, which deserves more than the
      // info line above.
      log.warn(
        "models",
        `model catalog dropped ${report.removed.length} previously held model(s): ${sample(report.removed)}`,
      );
    }
    return true;
  }

  function refresh(): Promise<boolean> {
    inFlight ??= refreshOnce().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
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
      unrefTimer(timer);
    },
    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
