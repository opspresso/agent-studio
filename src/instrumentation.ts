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

/**
 * Restart any managed MCP container this process cannot reach.
 *
 * Deliberately not awaited. A single restart pulls an image and polls SSM for up
 * to five minutes; blocking on that would hold the server before it listens, and
 * the container healthcheck (`GET /api/health`) would fail the very deployment
 * that was trying to fix things.
 */
function reconcileManagedMcp(managed: ManagedMcpUseCases): void {
  managed
    .reconcile()
    .then((outcomes) => {
      for (const outcome of outcomes) {
        if (outcome.action !== "healthy") {
          console.warn(
            `[managed-mcp] ${outcome.name}: ${outcome.action}${outcome.detail ? ` — ${outcome.detail}` : ""}`,
          );
        }
      }
      const count = (action: string) => outcomes.filter((o) => o.action === action).length;
      console.info(
        `[managed-mcp] reconciled ${outcomes.length} server(s): ` +
          `${count("healthy")} healthy, ${count("restarted")} restarted, ${count("failed")} failed`,
      );
    })
    .catch((error: unknown) => {
      // Repair is best-effort: a server that stays unreachable is the state we
      // started in, and it must not stop this instance from serving everything
      // else.
      console.error("[managed-mcp] reconcile failed", error);
    });
}

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertRequiredConfig, assertAccessControlConfig } = await import("@/lib/config");
    assertRequiredConfig();
    assertAccessControlConfig();
    const { registerShutdownSignals } = await import("@/shared/lifecycle");
    registerShutdownSignals();
    const { managedMcpUseCases } = await import("@/lib/container");
    // Undefined where this deployment cannot start containers at all; there is
    // then nothing managed to repair.
    if (managedMcpUseCases) {
      reconcileManagedMcp(managedMcpUseCases);
    }
  }
}
