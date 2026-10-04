import type { WorkspaceModelTransport } from "@/domain/workspace/modelGateway";
import type { TargetResolver } from "@/infrastructure/llm/providers";
import { readBodyText } from "@/shared/httpBody";
import { createNativeUsageObserver } from "./nativeModelUsage";
import { fetchProvider } from "@/infrastructure/llm/providerFetch";
import { beginWorkspaceModelRequest } from "@/lib/workspaceModelMetrics";

/** Memory and wire bounds for the transparent native protocol, independent of tool output bounds. */
const MAX_NATIVE_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_NATIVE_RESPONSE_BYTES = 64 * 1024 * 1024;

export function createWorkspaceModelTransport(resolve: TargetResolver): WorkspaceModelTransport {
  return { async forward(input) {
    const releaseMetric = beginWorkspaceModelRequest();
    const controller = new AbortController();
    const observer = createNativeUsageObserver(input.protocol);
    let finishing: Promise<void> | undefined;
    let captured: ReturnType<typeof observer.result> | undefined;
    const finish = (result = observer.result()) => {
      captured ??= result;
      // Retry only the same accounting snapshot. Never repeat the provider request.
      return finishing ??= (async () => {
        try { await input.finish(captured.usage, captured.complete); }
        catch { await input.finish(captured.usage, captured.complete); }
      })();
    };
    const close = async (result = observer.result()) => {
      try { await finish(result); }
      finally { releaseMetric(); }
    };
    let endpoint: string;
    let request: RequestInit;
    try {
      const target = await resolve(input.model);
      if (target.auth !== "bearer") throw new Error("Unsupported native authentication");
      const base = target.baseUrl.replace(/\/$/, "");
      endpoint = input.protocol === "messages" ? base.replace(/\/v1$/, "") + "/v1/messages" + (input.countTokens ? "/count_tokens" : "") : base + "/" + input.protocol;
      const headers = new Headers({ "Content-Type": "application/json" });
      for (const name of ["anthropic-version", "anthropic-beta", "openai-beta"]) {
        const value = input.headers[name];
        if (value && value.length <= 4096) headers.set(name, value);
      }
      if (input.protocol === "messages") {
        headers.set("x-api-key", target.apiKey); headers.set("anthropic-version", headers.get("anthropic-version") ?? "2023-06-01");
      } else headers.set("Authorization", "Bearer " + target.apiKey);
      const body: Record<string, unknown> = { ...input.body, model: target.model };
      if (input.protocol === "chat/completions" && body.stream === true) {
        body.stream_options = { ...(body.stream_options && typeof body.stream_options === "object" ? body.stream_options : {}), include_usage: true };
      }
      request = { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.any([input.signal, controller.signal]) };
    } catch {
      await close({ complete: true });
      throw new Error("Native model provider configuration is unavailable");
    }
    let upstream: Response;
    try { upstream = await fetchProvider(endpoint, request); }
    catch { await close(); throw new Error("Native model transport failed; request was not replayed"); }
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => {});
      // A provider refusal did not return a generation. Server/transport failure can be uncertain.
      if (upstream.status >= 400 && upstream.status < 500) {
        await close({ complete: true });
      } else await close();
      return Response.json({ error: { message: `Model provider refused request: HTTP ${upstream.status}` } }, { status: upstream.status });
    }
    if (!upstream.headers.get("content-type")?.includes("text/event-stream")) {
      try {
        const text = await readBodyText(upstream, MAX_NATIVE_FRAME_BYTES);
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object" && "error" in parsed && parsed.error != null) throw new Error("Native model response failed");
        if (input.countTokens) { await close({ complete: true }); }
        else { observer.observe(parsed, true); await close(); }
        return new Response(text, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
      } catch { await close(); throw new Error("Native model response or accounting failed"); }
    }
    if (!upstream.body) { await close(); throw new Error("Native model stream has no body"); }
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "";
    let bytes = 0;
    const observeFrame = (frame: string) => {
      const data = frame.split(/\r\n|\r|\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
      if (!data) return;
      const event: unknown = data === "[DONE]" ? data : JSON.parse(data);
      if (event && typeof event === "object" && (("error" in event && event.error != null) || ("type" in event && event.type === "error"))) throw new Error("Native model stream failed");
      observer.observe(event);
    };
    const stream = new ReadableStream<Uint8Array>({
      async pull(output) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            pending += decoder.decode();
            if (pending.trim()) observeFrame(pending);
            await close(); output.close(); return;
          }
          bytes += value.byteLength;
          if (bytes > MAX_NATIVE_RESPONSE_BYTES) throw new Error("Native model response limit exceeded");
          pending += decoder.decode(value, { stream: true });
          for (;;) {
            const boundary = /\r\n\r\n|\n\n|\r\r/.exec(pending);
            if (!boundary) break;
            if (Buffer.byteLength(pending.slice(0, boundary.index)) > MAX_NATIVE_FRAME_BYTES) throw new Error("Native model frame limit exceeded");
            observeFrame(pending.slice(0, boundary.index));
            pending = pending.slice(boundary.index + boundary[0].length);
          }
          if (Buffer.byteLength(pending) > MAX_NATIVE_FRAME_BYTES) throw new Error("Native model frame limit exceeded");
          if (observer.result().complete) await finish();
          output.enqueue(value);
        } catch {
          controller.abort();
          await reader.cancel().catch(() => {});
          try { await close(); } finally { output.error(new Error("Native model stream or accounting failed; request was not replayed")); }
        }
      },
      async cancel() { controller.abort(); await reader.cancel().catch(() => {}); await close(); },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
  } };
}
