/**
 * What a run that was stopped by the platform ends with.
 *
 * A run signal aborts for two reasons and they are not the same ending: the
 * caller went away, which nobody needs told about, or the run outlived
 * `MAX_RUN_DURATION_MS`, which is this deployment stopping a run that was
 * otherwise working. Only the second is an answer the caller is owed, and until
 * it had a type it was the one ending with no words: the abort reason travelled
 * out as a `DOMException`, so a collected caller was told "Internal server
 * error" and a streaming one "The operation was aborted due to timeout" — for a
 * documented limit, with the real reason only in this server's log.
 *
 * One owner because five run paths classify the same abort — both single-shot
 * paths, the agent loop, the image use case and a transferred-to child — and a
 * sixth that spelled it again would spell it differently. The list is
 * `RUN_ENDING_SITES` in `tests/architecture.test.ts`, which fails when a caller
 * of `withRunDeadline` does not classify what stopped it; this comment is not
 * the guard, it is the reason for one.
 */

import { RunDeadlineError } from "@/application/errors";
import { MAX_RUN_DURATION_MS, runDeadlineExceeded } from "@/shared/runDeadline";

/** The wording, from the module that owns the limit it names. */
export function runDeadlineMessage(): string {
  return `This run was stopped after ${Math.round(MAX_RUN_DURATION_MS / 1000)} seconds, the longest a single run may take.`;
}

/**
 * The error a run should end with, given what actually stopped it.
 *
 * One argument, and it is the *run* signal: which limit ended the run is
 * latched when it aborts (`withRunDeadline`), so a caller that drops while the
 * catch unwinds cannot erase a deadline that had already fired, and a deadline
 * that fires a moment after the reader left cannot turn their departure into a
 * failure the trace and the metrics then count.
 */
export function runEnding(error: unknown, runSignal: AbortSignal | undefined): unknown {
  if (!runDeadlineExceeded(runSignal)) {
    return error;
  }
  // The latch says the run was stopped; it does not say what the run was doing
  // when it was. Whatever was in flight — a provider that never answered, an
  // MCP call that hung — is carried as the cause, because "which one was it
  // stuck on for ten minutes" is the question a deadline investigation opens
  // with, and replacing the error outright is what left it unanswerable.
  return new RunDeadlineError(runDeadlineMessage(), { cause: error });
}
