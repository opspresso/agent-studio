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
 * Pull the first chunk before the response exists.
 *
 * A run is refused — over its daily cost limit, out of concurrency slots — on
 * the generator's *first* `next()`, which is before it has produced anything.
 * Constructing the `Response` first would send `200 text/event-stream` and then
 * deliver the refusal as a data frame, so the caller never sees the status or
 * the `Retry-After` that says when to come back. Awaiting one chunk here lets
 * that throw reach the route's `apiError`, which is what turns it into a 429.
 *
 * It costs nothing for a run that starts normally: the chunk is held and
 * emitted first, so the stream is byte-identical. Nothing is buffered beyond
 * that one chunk.
 */
async function createSseResponse(
  generator: AsyncGenerator<unknown>,
  includeDone: boolean,
  abortController?: AbortController,
): Promise<Response> {
  const first = await generator.next();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const keepalive = setInterval(() => {
        if (!cancelled) {
          controller.enqueue(KEEPALIVE_FRAME);
        }
      }, KEEPALIVE_INTERVAL_MS);
      try {
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
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: message })}\n\n`));
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
): Promise<Response> {
  return createSseResponse(generator, false, abortController);
}

export function sseResponse(
  generator: AsyncGenerator<unknown>,
  abortController?: AbortController,
): Promise<Response> {
  return createSseResponse(generator, true, abortController);
}
