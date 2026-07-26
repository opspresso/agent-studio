/**
 * Next.js instrumentation hook — runs once at server startup. Validates that
 * the required environment and access-control guardrails are in place so a
 * misconfiguration fails fast at boot rather than as a 500 on the first request
 * that touches the missing value, and arms graceful-shutdown signal handling.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertRequiredConfig, assertAccessControlConfig } = await import("@/lib/config");
    assertRequiredConfig();
    assertAccessControlConfig();
    const { registerShutdownSignals } = await import("@/shared/lifecycle");
    registerShutdownSignals();
  }
}
