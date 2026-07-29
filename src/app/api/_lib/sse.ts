/**
 * SSE helpers shared by chat and agent streaming routes.
 * Frames each value as `data: {json}\n\n` and terminates with `data: [DONE]\n\n`.
 */

const encoder = new TextEncoder();

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
