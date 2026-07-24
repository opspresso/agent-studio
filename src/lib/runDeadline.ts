/**
 * Wall-clock backstop for a single run. Composes the caller's abort signal
 * (client disconnect, A2A cancel) with a hard deadline so a hung provider/tool
 * call can never run — or bill — unbounded. Generous by default: only stuck or
 * runaway runs hit it, not legitimately long multi-turn / reasoning runs.
 *
 * Shared by the execution facade (agent / single-shot) and the image use case
 * so every run path — chat, Slack, A2A, predict, image — is bounded the same way.
 */
export const MAX_RUN_DURATION_MS = Number(process.env.MAX_RUN_DURATION_MS) || 600_000;

export function withRunDeadline(signal: AbortSignal | undefined): AbortSignal {
  const deadline = AbortSignal.timeout(MAX_RUN_DURATION_MS);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}
