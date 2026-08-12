/**
 * Parse an SSE `Response` body into decoded JSON chunks. Frames are
 * `data: {json}\n\n` and the stream ends on `data: [DONE]`. Malformed frames
 * are ignored. The single client-side SSE reader — server framing lives in
 * `src/app/api/_lib/sse.ts`.
 */
export async function* readSse<T>(response: Response): AsyncGenerator<T> {
  const reader = response.body?.getReader();
  if (!reader) {
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";

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
        try {
          yield JSON.parse(data) as T;
        } catch {
          // Ignore malformed frames.
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}
