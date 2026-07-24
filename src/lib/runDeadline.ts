/**
 * Wall-clock backstop for a single run. Composes the caller's abort signal
 * (client disconnect, A2A cancel) with a hard deadline so a hung provider/tool
 * call can never run — or bill — unbounded. Generous by default: only stuck or
 * runaway runs hit it, not legitimately long multi-turn / reasoning runs.
 *
 * Shared by the execution facade (agent / single-shot) and the image use case
 * so every run path — chat, Slack, A2A, predict, image — is bounded the same way.
 */

const DEFAULT_MAX_RUN_DURATION_MS = 600_000;
/** setTimeout / AbortSignal.timeout reject delays outside [1, 2**31 - 1] ms. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Validate the `MAX_RUN_DURATION_MS` override against `AbortSignal.timeout`'s
 * domain (a positive, in-range integer). `Number(raw) || default` would let
 * `-1` / `Infinity` / non-integers / out-of-range values through and make every
 * run throw a RangeError synchronously; fall back to the default (with a warning)
 * instead so a misconfigured value degrades safely rather than breaking all runs.
 */
export function parseMaxRunDuration(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_MAX_RUN_DURATION_MS;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    console.warn(
      `[runDeadline] ignoring invalid MAX_RUN_DURATION_MS="${raw}"; using ${DEFAULT_MAX_RUN_DURATION_MS}ms`,
    );
    return DEFAULT_MAX_RUN_DURATION_MS;
  }
  return value;
}

export const MAX_RUN_DURATION_MS = parseMaxRunDuration(process.env.MAX_RUN_DURATION_MS);

export function withRunDeadline(signal: AbortSignal | undefined): AbortSignal {
  const deadline = AbortSignal.timeout(MAX_RUN_DURATION_MS);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}
