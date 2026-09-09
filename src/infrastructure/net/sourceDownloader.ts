import type { SourceDownloader } from "@/domain/artifact/sourceReference";
import { HttpResourceError } from "@/domain/net/httpResource";
import { fetchPublicUrl } from "./publicFetch";
import { parseContentType } from "./httpResource";
import { refuseDeclaredLength } from "@/shared/httpBody";

/** A streaming GET through the existing per-hop SSRF and redirect policy. */
export const sourceDownloader: SourceDownloader = {
  async open(url, signal, maxBytes) {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new HttpResourceError("Invalid source download limit");
    const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(600_000)]);
    let response: Response;
    try {
      response = await fetchPublicUrl(url, { method: "GET", signal: operationSignal,
        headers: { accept: "audio/*,application/octet-stream" } });
    } catch {
      operationSignal.throwIfAborted();
      throw new HttpResourceError("Source download was refused or unavailable");
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new HttpResourceError(`Source download returned HTTP ${response.status}`);
    }
    await refuseDeclaredLength(response, maxBytes);
    const stream = response.body;
    const reader = stream.getReader();
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    };
    return {
      mimeType: parseContentType(response.headers.get("content-type")).mimeType,
      body: Object.assign((async function* () {
        try {
          for (;;) {
            operationSignal.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) break;
            yield value;
          }
        } catch {
          operationSignal.throwIfAborted();
          throw new HttpResourceError("Source download stream failed");
        } finally {
          await close();
        }
      })(), { close }),
    };
  },
};
