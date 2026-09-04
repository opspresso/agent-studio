/**
 * Process lifecycle state for graceful shutdown. On SIGTERM/SIGINT the instance
 * flips to "draining" so the readiness probe reports unready and the load
 * balancer deregisters it, while the standalone server drains in-flight requests
 * before exit. This module never calls process.exit — the runtime owns that.
 */

import { log } from "./logger";

let draining = false;

export function isShuttingDown(): boolean {
  return draining;
}

type ShutdownHook = () => void | Promise<void>;
const hooks: ShutdownHook[] = [];

function runShutdownHook(hook: ShutdownHook): void {
  void Promise.resolve()
    .then(hook)
    .catch((error: unknown) => log.error("boot", "shutdown hook failed", error));
}

/**
 * Run `hook` when the instance begins draining — a last chance to flush a
 * buffer (OTLP spans) while requests finish. Best-effort: the drain never
 * waits on a hook, and a hook that throws is logged, not fatal.
 */
export function onShutdown(hook: ShutdownHook): void {
  if (draining) {
    runShutdownHook(hook);
    return;
  }
  hooks.push(hook);
}

/** Mark the instance unready. Exposed as the signal handler and for tests. */
export function beginShutdown(): void {
  if (draining) {
    return;
  }
  draining = true;
  for (const hook of hooks) {
    runShutdownHook(hook);
  }
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
