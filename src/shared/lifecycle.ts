/**
 * Process lifecycle state for graceful shutdown. On SIGTERM/SIGINT the instance
 * flips to "draining" so the readiness probe reports unready and the load
 * balancer deregisters it, while the standalone server drains in-flight requests
 * before exit. This module never calls process.exit — the runtime owns that.
 */

let draining = false;

export function isShuttingDown(): boolean {
  return draining;
}

/** Mark the instance unready. Exposed as the signal handler and for tests. */
export function beginShutdown(): void {
  draining = true;
}

let registered = false;

/** Attach SIGTERM/SIGINT handlers that mark the instance unready. Idempotent. */
export function registerShutdownSignals(): void {
  if (registered) {
    return;
  }
  registered = true;
  process.on("SIGTERM", beginShutdown);
  process.on("SIGINT", beginShutdown);
}
