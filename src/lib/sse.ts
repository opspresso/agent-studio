/**
 * SSE helpers shared by chat and agent streaming routes.
 * Frames each value as `data: {json}\n\n` and terminates with `data: [DONE]\n\n`.
 */

const encoder = new TextEncoder();

function createSseResponse(
  generator: AsyncGenerator<unknown>,
  includeDone: boolean,
  abortController?: AbortController,
): Response {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
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
): Response {
  return createSseResponse(generator, false, abortController);
}

export function sseResponse(
  generator: AsyncGenerator<unknown>,
  abortController?: AbortController,
): Response {
  return createSseResponse(generator, true, abortController);
}
