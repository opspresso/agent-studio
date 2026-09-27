/**
 * Boot validates configuration, prepares the schema and audit sink, and loads
 * selected models before serving. Managed MCP repair runs in the background;
 * its containers publish ports on the host loopback.
 * Node-only imports stay inside the runtime guard so edge builds exclude them.
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
    // Wire audit storage before any request can perform an audited action.
    const [{ setAuditSink, assertAuditSinkWired }, { auditRepository }] = await Promise.all([
      import("@/application/audit/recordAudit"),
      import("@/infrastructure/db/repositories/auditRepository"),
    ]);
    setAuditSink(auditRepository);
    // Fail boot if this module instance has no sink. Duplicate module instances
    // must be prevented by the build; this assertion cannot detect them.
    assertAuditSinkWired();
    // Required boot paths read only the deployment's persisted model selections.
    const { getLlmProviderConfigs, startPublishedModelRefresh } = await import("@/lib/runtime-settings");
    await getLlmProviderConfigs();
    startPublishedModelRefresh();
    // Optional container repair must not delay the server's readiness to listen.
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
