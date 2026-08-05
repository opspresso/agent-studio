/**
 * How a chat run reaches the browser — the one place that says it.
 *
 * A chat run is not the response that started it. The browser closing the
 * connection used to close the generator and unwind the run; now the stream
 * detaches instead (`src/shared/detachOnReturn.ts`) and the run finishes on its
 * own, persisting its answer for whoever asks next. That makes one decision of
 * what was about to be two copies across two routes: the detach, and telling the
 * runtime the work outlives the response.
 *
 * The consequence to keep in mind everywhere else: **a chat route must not pass
 * an `AbortController` to `sseResponse`.** Doing so restores the old behaviour
 * exactly, and it looks like tidying up.
 */

import { after } from "next/server";
import { detachOnReturn } from "@/shared/detachOnReturn";
import { log } from "@/shared/logger";
import { sseResponse } from "@/app/api/_lib/sse";
import { withRunFrames } from "./frames";

export interface DetachedRun {
  head: Record<string, unknown>;
  stream: AsyncGenerator<unknown>;
  /** Told the moment the reader leaves, so the run starts writing itself down. */
  onClientGone: () => void;
  /** Runs once the run is over, however it ended. The cancel watch stops here. */
  onDrained: () => void;
}

/** Stream a chat run, detached from the connection carrying it. */
export async function detachedRunResponse(run: DetachedRun): Promise<Response> {
  // `withRunFrames` is a plain generator and must stay *inside* the detach: a
  // generator parked at an `await` cannot answer `return()`, so layered above it
  // the disconnect would never reach the wrapper that handles it.
  const { stream: detached, drained } = detachOnReturn(
    withRunFrames(run.head, run.stream),
    run.onClientGone,
  );
  void drained.finally(run.onDrained);

  // Before anything is registered: `sseResponse` pulls the first chunk, which is
  // where a refused run (over its cost limit, out of slots) throws, and that
  // throw has to reach the route's `apiError` as a 429.
  const response = await sseResponse(detached);

  // Not what keeps the run alive — its own pending I/O does that. This is what
  // makes a graceful shutdown wait for it rather than cutting it mid-answer.
  try {
    after(() => drained);
  } catch (error) {
    log.warn("chat", "detached run is not registered with the runtime", error);
  }
  return response;
}
