/**
 * The envelope around a chat run's engine chunks.
 *
 * `head` tells the client which run it is watching before any content arrives —
 * the chat id on a new chat, and the run id both surfaces need to reattach to a
 * run or stop it.
 *
 * The trailing frame tells it the run *finished*, which a closed body cannot:
 * `readSse` sees a truncated stream and a completed one identically, and a
 * client that cannot tell them apart either reconnects when there is nothing to
 * reconnect to, or reports a cut-off run as a finished answer. It is deliberately
 * not emitted when the stream throws — the SSE layer sends an `{error}` frame
 * there, and that is a different ending.
 *
 * Kept apart from `detachedRun.ts` so this stays testable: that module imports
 * `next/server` for `after()`, which only exists inside a request.
 */
export async function* withRunFrames(
  head: Record<string, unknown>,
  stream: AsyncGenerator<unknown>,
): AsyncGenerator<unknown> {
  // The head frame goes out before the run is pulled at all, and that ordering
  // is load-bearing: `sseResponse` builds the `Response` around its first value,
  // so until this yields something there are no headers, no keepalive and no
  // chat id on the wire. The run's first chunk can be a minute out — a reasoning
  // prefill, a heavy document turn — and a connection that has sent zero bytes
  // for 60s is one the ALB cuts, leaving the client with no run to reattach to
  // or stop while the run itself carries on detached.
  //
  // The cost is the refusal path: a run turned away — over its daily cost
  // limit, out of slots — throws on its first `next()`, which now lands after
  // the response has committed to `200 text/event-stream`, so it arrives as the
  // SSE layer's `{error}` frame rather than as a 429 with a `Retry-After`. The
  // only readers of these two routes are the chat client, which draws that
  // frame as the run's error either way; the agent API routes, whose callers do
  // read statuses, still get theirs from `sseResponse`'s own first pull.
  yield head;
  yield* stream;
  yield { ended: true };
}

/**
 * The same envelope around a run being *watched* rather than started.
 *
 * The head frame goes first here, with nothing pulled ahead of it. It has to:
 * nothing in a replay can be refused — `openRunLogReplay` has already awaited
 * the ownership check and thrown its 404 — and the log of a run another window
 * is attached to is empty by design, so its first frame is the quiet notice five
 * seconds later. Pulling for that before answering would leave the browser with
 * no status line and no headers for five seconds, which a proxy reads as a dead
 * backend rather than a slow one.
 */
export async function* withReplayFrames(
  head: Record<string, unknown>,
  stream: AsyncGenerator<unknown>,
): AsyncGenerator<unknown> {
  yield head;
  yield* stream;
  yield { ended: true };
}
