/**
 * Parse an SSE `Response` body into decoded JSON chunks. Frames are
 * `data: {json}\n\n` and the stream ends on `data: [DONE]`. The single
 * client-side SSE reader — server framing lives in
 * `src/app/api/_lib/sse.ts`.
 */
export async function* readSse<T>(
  response: Response,
  { requireDone = true }: { requireDone?: boolean } = {},
): AsyncGenerator<T> {
  const body = response.body;
  const reader = body?.getReader();
  if (!reader) {
    if (requireDone) {
      throw new Error("SSE response has no body");
    }
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 2);
        if (frame.startsWith("data:")) {
          const data = frame.slice(5).trim();
          if (data === "[DONE]") {
            return;
          }
          let chunk: T;
          try {
            chunk = JSON.parse(data) as T;
          } catch (error) {
            throw new Error("Malformed SSE data frame", { cause: error });
          }
          yield chunk;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      throw new Error("SSE stream ended with an incomplete frame");
    }
    if (requireDone) {
      throw new Error("SSE stream ended without [DONE]");
    }
  } finally {
    reader.releaseLock();
    await body?.cancel().catch(() => {});
  }
}
