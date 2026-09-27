/**
 * Convert the platform's own run deadline to a reader-facing 504 while
 * preserving caller cancellation and the original cause. Architecture tests
 * require deadline-composing execution sites to use this classification.
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
  // Keep the provider/tool error as the cause for deadline investigations.
  return new RunDeadlineError(runDeadlineMessage(), { cause: error });
}
