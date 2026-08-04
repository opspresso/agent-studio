/**
 * Wall-clock backstop for a single run. Composes the caller's abort signal
 * (client disconnect, A2A cancel) with a hard deadline so a hung provider/tool
 * call can never run — or bill — unbounded. Generous by default: only stuck or
 * runaway runs hit it, not legitimately long multi-turn / reasoning runs.
 *
 * Shared by the execution facade (agent / single-shot) and the image use case
 * so every run path — chat, Slack, A2A, predict, image — is bounded the same way.
 *
 * **The one env read below `lib`, and deliberate.** `src/lib/config.ts` owns
 * configuration, but `application` may not import `lib` and this bound is a
 * process-level backstop rather than a per-run setting — there is nothing to
 * inject it through that would not mean threading a deadline into every run
 * path. `tests/architecture.test.ts` names this file as the single exception, so
 * a second env read in `domain` or `shared` fails rather than passing unnoticed.
 * `docs/CONFIGURATION.md` documents `MAX_RUN_DURATION_MS` with the rest.
 */

import { log } from "./logger";

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
    log.warn(
      "config",
      `ignoring invalid MAX_RUN_DURATION_MS="${raw}"; using ${DEFAULT_MAX_RUN_DURATION_MS}ms`,
    );
    return DEFAULT_MAX_RUN_DURATION_MS;
  }
  return value;
}

export const MAX_RUN_DURATION_MS = parseMaxRunDuration(process.env.MAX_RUN_DURATION_MS);

/**
 * How long one instance holds a claim on work it is running (a chat's active
 * run, a Slack event being processed). Derived from the run deadline so the two
 * can never drift apart: a lease outlives the longest possible run by the margin
 * below and no more, so an instance that dies mid-run frees its claim shortly
 * after the work could have finished rather than blocking it for an unrelated
 * fixed window.
 */
export const RUN_LEASE_SECONDS = Math.ceil(MAX_RUN_DURATION_MS / 1000) + 60;

export function withRunDeadline(signal: AbortSignal | undefined): AbortSignal {
  const deadline = AbortSignal.timeout(MAX_RUN_DURATION_MS);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

/**
 * The tighter cap an interactive surface layers over the run deadline. A Slack
 * thread shows a live "thinking" status while a run works, and three minutes is
 * where that stops being worth waiting on. The surface passes this as the
 * caller signal, so the run's own deadline above still applies — the cap can
 * only shorten a run, never extend one. It lives here because this module is
 * the one place that says how long a run may last; the Slack path once kept a
 * bare timeout constant of its own, which is a second deadline nobody tuning
 * `MAX_RUN_DURATION_MS` could see.
 */
export const INTERACTIVE_RUN_TIMEOUT_MS = 3 * 60 * 1000;
