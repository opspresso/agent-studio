/**
 * Next.js instrumentation hook — runs once at server startup. Validates that
 * the required environment is present so a misconfiguration fails fast at boot
 * rather than as a 500 on the first request that touches the missing value.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertRequiredConfig } = await import("@/lib/config");
    assertRequiredConfig();
  }
}
