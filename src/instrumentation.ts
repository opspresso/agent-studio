/**
 * Next.js instrumentation hook — runs once at server startup. Validates that
 * the required environment and access-control guardrails are in place so a
 * misconfiguration fails fast at boot rather than as a 500 on the first request
 * that touches the missing value, and arms graceful-shutdown signal handling.
 *
 * It also loads the published model catalog over the committed snapshot and
 * keeps it refreshed, and repairs managed MCP servers, because a new process
 * is exactly the event that breaks them: their containers join this app's
 * network namespace, and replacing this app strands them in the old one.
 *
 * Every `import()` here stays lexically inside the `NEXT_RUNTIME` check. This
 * file is compiled for the edge runtime too, where that comparison folds to
 * false and takes the imports with it — hoisting one out to module scope pulls
 * `node:crypto` and the AWS SDK into a bundle that cannot load them.
 */

import type { ManagedMcpUseCases } from "@/application/mcp/managedMcpUseCases";
import { log } from "@/shared/logger";

/**
 * Restart any managed MCP container this process cannot reach.
 *
 * Deliberately not awaited. A single restart pulls an image and waits on the container for up
 * to five minutes; blocking on that would hold the server before it listens, and
 * the container healthcheck (`GET /api/health`) would fail the very deployment
 * that was trying to fix things.
 */
function reportReconcile(managed: ManagedMcpUseCases): Promise<void> {
  return managed
    .reconcile()
    .then((outcomes) => {
      for (const outcome of outcomes) {
        if (outcome.action !== "healthy") {
          log.warn(
            "managed-mcp",
            `${outcome.name}: ${outcome.action}${outcome.detail ? ` — ${outcome.detail}` : ""}`,
          );
        }
      }
      const count = (action: string) => outcomes.filter((o) => o.action === action).length;
      log.info(
        "managed-mcp",
        `reconciled ${outcomes.length} server(s): ` +
          `${count("healthy")} healthy, ${count("restarted")} restarted, ` +
          `${count("failed")} failed, ${count("skipped")} skipped`,
      );
    })
    .catch((error: unknown) => {
      // Repair is best-effort: a server that stays unreachable is the state we
      // started in, and it must not stop this instance from serving everything
      // else.
      log.error("managed-mcp", "reconcile failed", error);
    });
}

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertRequiredConfig, assertAccessControlConfig } = await import("@/lib/config");
    assertRequiredConfig();
    assertAccessControlConfig();
    const { registerShutdownSignals } = await import("@/shared/lifecycle");
    registerShutdownSignals();
    // The schema before anything reads it. Awaited and fatal: a process that
    // cannot reach its database has nothing to serve, and an instance racing
    // another's migration waits on the advisory lock rather than failing.
    const { migrate } = await import("@/infrastructure/db/migrations");
    await migrate();
    // The first administrator of an installation with no identity provider
    // reachable yet. A no-op everywhere else.
    const { ensureBootstrapAdmin } = await import("@/lib/auth");
    await ensureBootstrapAdmin();
    // Awaited, unlike the composition root below. The sink is what makes
    // `recordAudit` write anything, and the root wires it only as a side effect
    // of being imported — which the A2A-key reveal route never does, since it
    // needs nothing from it. A request served before that floating import
    // resolves would reveal a credential and record no row, and an unrecorded
    // act is indistinguishable from one that never happened. Two AWS SDK
    // modules, no client construction (the document client is lazy), so this
    // costs the boot path nothing measurable.
    const [{ setAuditSink, assertAuditSinkWired }, { auditRepository }] = await Promise.all([
      import("@/application/audit/recordAudit"),
      import("@/infrastructure/db/repositories/auditRepository"),
    ]);
    setAuditSink(auditRepository);
    // Refuses the boot if that push did not take — an adapter export that failed
    // to initialise, a barrel resolving to `undefined`. Narrow on purpose, and
    // the docblock says why: read back through the same module instance it was
    // pushed to, this cannot see a *duplicate* of that module left empty, and
    // nothing in-process can. Without it the same defect is silent until the
    // first audited act, which writes nothing and says nothing.
    assertAuditSinkWired();
    // The model registry: the committed snapshot until this lands, today's
    // published catalog after. Awaited so the first request prices against
    // the catalog rather than the snapshot, and bounded by the source's own
    // deadline; a failure keeps the snapshot and is logged, never fatal. The
    // refresher then re-reads on its interval for the life of the process.
    const [
      { createModelCatalogRefresher },
      { createCompositeModelCatalogSource },
      { createHttpModelCatalogSource },
      { modelCatalogRepository },
      { config },
    ] = await Promise.all([
      import("@/application/llm/modelCatalogRefresh"),
      import("@/application/llm/modelCatalogStoredSource"),
      import("@/infrastructure/llm/modelCatalogHttpSource"),
      import("@/infrastructure/db/repositories/modelCatalogRepository"),
      import("@/lib/config"),
    ]);
    const modelCatalog = createModelCatalogRefresher({
      // An admin's uploaded document over the published catalog, and under
      // no `MODELS_CATALOG_URL` or `none` (answered as `undefined`) means the
      // upload alone: no fetch leaves this process, and a tick with nothing
      // stored is silent. The same composition the console's refresh button
      // uses (`lib/container.ts`).
      source: createCompositeModelCatalogSource({
        stored: modelCatalogRepository,
        remote:
          config.modelsCatalogUrl === undefined
            ? undefined
            : createHttpModelCatalogSource(config.modelsCatalogUrl),
      }),
      intervalMs: config.modelsCatalogRefreshMs,
      // The second publisher: this deployment's own self-hosted declarations,
      // re-read on the same schedule so a settings write on another instance
      // reaches this process within a tick. Deadlined like the catalog fetch —
      // the boot refresh is awaited before the first request, and a hung
      // settings table must not hold the boot the way an unreachable one
      // (which rejects fast and is logged) already cannot.
      localModels: async () => {
        const [{ getSelfHostedModels }, { withTimeout }] = await Promise.all([
          import("@/lib/runtime-settings"),
          import("@/shared/withTimeout"),
        ]);
        return withTimeout(getSelfHostedModels(), 10_000);
      },
    });
    await modelCatalog.refresh();
    modelCatalog.start();
    // The import is inside the guard so the edge build folds it away, and off
    // the awaited path because evaluating the composition root constructs every
    // AWS client — `register` is awaited before the server accepts connections,
    // so anything left here lands in cold-start latency.
    void (async () => {
      const { managedMcpUseCases } = await import("@/lib/container");
      // Undefined where this deployment cannot start containers at all; there
      // is then nothing managed to repair.
      if (managedMcpUseCases) {
        await reportReconcile(managedMcpUseCases);
      }
    })().catch((error: unknown) => {
      // Not "reconcile failed": the sweep terminates its own errors above, so
      // the only thing that reaches here is the composition root refusing to
      // load — a different and much larger problem than an unreachable
      // container, and one that would be misread under the other message.
      log.error("managed-mcp", "could not load the composition root to reconcile", error);
    });
  }
}
