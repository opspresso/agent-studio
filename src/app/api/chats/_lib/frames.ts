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
  // The run's first chunk is pulled *before* the head frame, for the same reason
  // `sseResponse` pulls one before building a `Response`: a refused run — over
  // its daily cost limit, out of slots — throws on that first `next()`, and a
  // head frame emitted ahead of it would have already committed the response to
  // `200 text/event-stream`. The refusal would then arrive as a data frame, and
  // the caller would never see the status or the `Retry-After`. Nothing is
  // buffered beyond that one chunk, and the frames come out in the same order.
  //
  // The cost is that the head frame waits on the run's first chunk, so a new
  // chat learns its own id a beat later than it used to. That is invisible — the
  // view is already showing the sent turn and an empty reply — and it buys back
  // a refusal the create route had been delivering as a `200` all along.
  const first = await stream.next();
  yield head;
  if (!first.done) {
    yield first.value;
    yield* stream;
  }
  yield { ended: true };
}
