/** Process-local native Gateway load, independent of worker-owned Workspace runs. */
const METRICS_SLOT = Symbol.for("opspresso.agent-studio.workspace-model-metrics");
const scope = globalThis as typeof globalThis & { [METRICS_SLOT]?: { activeRequests: number } };
// Route and adapter code can be loaded from different Next.js server bundles.
const state = scope[METRICS_SLOT] ??= { activeRequests: 0 };

/** Keep a request active through its response body; release is idempotent. */
export function beginWorkspaceModelRequest(): () => void {
  state.activeRequests += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    state.activeRequests -= 1;
  };
}

export function activeWorkspaceModelRequests(): number {
  return state.activeRequests;
}
