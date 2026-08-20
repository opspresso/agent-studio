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
 * One owner because four run paths classify the same abort — both single-shot
 * paths, the agent loop and the image use case — and a fifth that spelled it
 * again would spell it differently.
 */

import { RunDeadlineError } from "@/application/errors";
import { MAX_RUN_DURATION_MS, runDeadlineExceeded } from "@/shared/runDeadline";

/** The wording, from the module that owns the limit it names. */
export function runDeadlineMessage(): string {
  return `This run was stopped after ${Math.round(MAX_RUN_DURATION_MS / 1000)} seconds, the longest a single run may take.`;
}

/**
 * The error a run should end with, given what actually aborted it.
 *
 * The caller's own cancellation wins: a reader who left is not owed a reason,
 * and a deadline that fires in the same tick must not turn their departure into
 * a failure the trace and the metrics then count.
 */
export function runEnding(
  error: unknown,
  signals: { run?: AbortSignal; caller?: AbortSignal },
): unknown {
  if (signals.caller?.aborted || !runDeadlineExceeded(signals.run)) {
    return error;
  }
  return new RunDeadlineError(runDeadlineMessage());
}
