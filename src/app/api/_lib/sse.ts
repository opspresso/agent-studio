/**
 * SSE helpers shared by chat and agent streaming routes.
 * Frames each value as `data: {json}\n\n` and terminates with `data: [DONE]\n\n`.
 */

const encoder = new TextEncoder();

/**
 * Idle middleboxes cut silent connections — the ALB in front of the deployed
 * app kills any connection with no bytes for 60s, which is shorter than one
 * image generation or a long tool call, during which the engine yields nothing.
 * SSE comments keep bytes flowing without entering the protocol: spec parsers
 * and `readSse` both discard frames that do not start with `data:`.
 */
const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE_FRAME = encoder.encode(": keepalive\n\n");

/**
 * How long the first chunk may take before the response is built without it.
 *
 * Two different things happen before an agent run's first chunk, and they are
 * nothing like the same length. The guards are settings and database reads —
 * milliseconds. `resolveRunTools` is not: it opens every bound MCP server and
 * lists its tools, which `CONFIGURATION.md` bounds at ~20s for one slow server,
 * and with `dynamicCapabilities` on it also embeds and searches the catalog. A
 * failure from either half is a status while this is still waiting and an
 * `{error}` frame afterwards, so the bound has to clear the slow half or it
 * trades away the 4xx that says what went wrong — which is why it is not the
 * few seconds the guards alone would need.
 *
 * The ceiling is the 60s idle budget the keepalive exists to defend: nothing
 * flows until the response is built, so this is spent from that budget, and
 * what is left has to cover a 15s keepalive interval with room over.
 */
const FIRST_CHUNK_GRACE_MS = 25_000;

/**
 * Give the run a moment to be refused, then stop waiting.
 *
 * Waits for the outcome of `pending`, not its value — the chunk is read from
 * the same promise later, since a `next()` is not cancellable and asking twice
 * would drop what it eventually produces. A rejection inside the grace period
 * is rethrown, which is what turns a refusal into a status rather than a data
 * frame; one that lands after it is left for the stream to report, and marked
 * handled here so it is not also an unhandled rejection.
 */
async function awaitFirstChunkBriefly(pending: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = pending.then(() => undefined);
  settled.catch(() => undefined);
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, FIRST_CHUNK_GRACE_MS);
  });
  try {
    await Promise.race([settled, grace]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull the first chunk before the response exists — but not indefinitely.
 *
 * A run is refused — over its daily cost limit, out of concurrency slots — on
 * the generator's *first* `next()`, which is before it has produced anything.
 * Constructing the `Response` first would send `200 text/event-stream` and then
 * deliver the refusal as a data frame, so the caller never sees the status or
 * the `Retry-After` that says when to come back. Awaiting one chunk here lets
 * that throw reach the route's `apiError`, which is what turns it into a 429.
 *
 * The wait is bounded because the keepalive above cannot start until the
 * response exists, so every second spent here is a second of the 60s idle
 * budget spent in silence. Two runs routinely produce nothing for longer than
 * that: an image, whose bytes arrive in one chunk at the end, and a reasoning
 * model whose thinking a version did not opt into recording — that stream's
 * first chunk is the end-of-turn usage. Both used to be cut mid-run for
 * looking idle while they were working.
 *
 * It costs nothing for a run that starts normally: the chunk is held and
 * emitted first, so the stream is byte-identical. Nothing is buffered beyond
 * that one chunk.
 */
/**
 * How a failure after the response exists is framed.
 *
 * The default is the `{error}` frame every OpenAI-shaped and chat stream
 * reads. A protocol with its own vocabulary — AG-UI's `RUN_ERROR` — hands in
 * the frame its clients parse, because a frame outside the protocol's schema
 * is not an error to them but a stream they reject.
 */
export interface SseOptions {
  errorFrame?: (message: string) => unknown;
}

async function createSseResponse(
  generator: AsyncGenerator<unknown>,
  includeDone: boolean,
  abortController?: AbortController,
  options: SseOptions = {},
): Promise<Response> {
  const pending = generator.next();
  // A refusal throws out of here and never reaches the response below.
  await awaitFirstChunkBriefly(pending);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const keepalive = setInterval(() => {
        if (!cancelled) {
          controller.enqueue(KEEPALIVE_FRAME);
        }
      }, KEEPALIVE_INTERVAL_MS);
      try {
        // Already settled unless the grace period won, in which case the wait
        // happens here — with the keepalive running, where silence costs
        // nothing. Nothing is buffered beyond this one chunk.
        const first = await pending;
        if (!first.done) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(first.value)}\n\n`));
        }
        for await (const chunk of generator) {
          if (!cancelled) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
        }
        if (includeDone && !cancelled) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "stream error";
          const frame = options.errorFrame ? options.errorFrame(message) : { error: message };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        }
      } finally {
        clearInterval(keepalive);
        if (!cancelled) {
          controller.close();
        }
      }
    },
    async cancel(reason) {
      cancelled = true;
      abortController?.abort(reason);
      await generator.return(undefined);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/**
 * SSE response without the OpenAI-style `[DONE]` terminator, for protocols
 * (e.g. A2A JSON-RPC streaming) whose clients treat every `data:` frame as
 * JSON and end on stream close.
 */
export function sseResponseRaw(
  generator: AsyncGenerator<unknown>,
  abortController?: AbortController,
  options?: SseOptions,
): Promise<Response> {
  return createSseResponse(generator, false, abortController, options);
}

export function sseResponse(
  generator: AsyncGenerator<unknown>,
  abortController?: AbortController,
): Promise<Response> {
  return createSseResponse(generator, true, abortController);
}
