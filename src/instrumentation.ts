/**
 * Next.js instrumentation hook — runs once at server startup. Validates that
 * the required environment and access-control guardrails are in place so a
 * misconfiguration fails fast at boot rather than as a 500 on the first request
 * that touches the missing value, and arms graceful-shutdown signal handling.
 *
 * It also repairs managed MCP servers, because a new process is exactly the
 * event that breaks them: their containers join this app's network namespace,
 * and replacing this app strands them in the old one.
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
 * Deliberately not awaited. A single restart pulls an image and polls SSM for up
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
    // Reads back what the push landed on, which is not the tautology it looks
    // like: the two are the same `let` only if both sides resolved the same
    // module instance. A bundle that ends up with two copies leaves this one
    // wired and the one every route imports empty — a server that records
    // nothing and says nothing about it. Fails fast here, beside the config
    // guardrails, because there is no later moment that could notice.
    assertAuditSinkWired();
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
